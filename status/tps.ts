/**
 * Token Speed Engine — end-to-end TPS + TTFT
 *
 * Two metrics, both computed once per assistant turn:
 *   1. TPS — provider-reported output tokens / full turn wall time
 *            (HTTP request sent → message_end). Reported only after finish().
 *   2. TTFT — wall-clock from HTTP request to first text/thinking delta.
 *
 * TPS is end-to-end: it includes prefill/TTFT, so it reflects the throughput
 * the user actually experiences for the whole turn. The provider's real token
 * count is used (no char-based estimation), so it is accurate, not a live guess.
 */

export class TokenSpeedEngine {
  private _isStreaming = false;
  private _finished = false;

  // Turn timing — full wall window for end-to-end TPS
  private _turnStartTime = 0;   // HTTP request sent (before_provider_request)
  private _turnEndTime = 0;     // message_end

  // TTFT
  private _firstTokenArrived = false;
  private _ttftMs = 0;

  // Real token count (from message_end usage)
  private _realOutputTokens = 0;

  get isStreaming() { return this._isStreaming; }

  /**
   * End-to-end tokens per second.
   *
   * Zero until finish(): a single accurate number is reported per turn using
   * the provider's real output token count over the full request→end window.
   */
  get tps(): number {
    if (!this._finished || this._realOutputTokens === 0 || this._turnStartTime === 0) return 0;
    const elapsedSec = (this._turnEndTime - this._turnStartTime) / 1000;
    return elapsedSec > 0 ? this._realOutputTokens / elapsedSec : 0;
  }

  /**
   * TTFT in seconds.
   *
   * Before first token arrives: returns a live (Date.now() - turnStart) value
   * so the status header shows a counting-up timer while the user waits.
   *
   * After first token: returns the frozen measured TTFT.
   */
  get ttftSec(): number {
    if (this._firstTokenArrived) return this._ttftMs / 1000;
    if (this._isStreaming && this._turnStartTime > 0) {
      return (Date.now() - this._turnStartTime) / 1000;
    }
    return this._ttftMs / 1000;
  }

  /**
   * Call on before_provider_request.
   * Marks the start of the turn's wall window.
   */
  recordHttpRequest() {
    this._turnStartTime = Date.now();
  }

  /**
   * Call on message_start (assistant).
   * Resets per-turn state; adopts the captured request time as turn start.
   */
  start() {
    this._isStreaming = true;
    this._finished = false;
    this._realOutputTokens = 0;
    this._firstTokenArrived = false;
    this._ttftMs = 0;
    this._turnEndTime = 0;
    if (this._turnStartTime === 0) this._turnStartTime = Date.now();
  }

  /**
   * Call on each text_delta / thinking_delta.
   * Only the first arrival matters: it freezes TTFT. Later calls are no-ops.
   */
  recordToken(_delta: string) {
    if (!this._isStreaming || this._firstTokenArrived) return;
    this._firstTokenArrived = true;
    this._ttftMs = Date.now() - this._turnStartTime;
  }

  /**
   * Call on message_end (assistant).
   * Freezes the turn window and injects the provider-reported output token
   * count so the final status render shows accurate end-to-end TPS.
   */
  finish(realOutputTokens?: number) {
    this._isStreaming = false;
    this._finished = true;
    this._turnEndTime = Date.now();
    if (realOutputTokens !== undefined && realOutputTokens > 0) {
      this._realOutputTokens = realOutputTokens;
    }
  }

  /** Full reset (e.g. on session_shutdown). */
  stop() {
    this._isStreaming = false;
    this._finished = false;
    this._turnStartTime = 0;
    this._turnEndTime = 0;
  }
}
