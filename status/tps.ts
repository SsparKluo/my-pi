/**
 * Token Speed Engine — end-to-end TPS + TTFT, accumulated across a whole turn.
 *
 * A single agent turn can span several provider requests (one per tool-call
 * round). Two metrics, both computed over the entire turn:
 *   1. TPS — total provider-reported output tokens across all requests in the
 *            turn / sum of each request's wall time (HTTP request → message_end).
 *            Tool-execution gaps between requests are excluded, so TPS reflects
 *            real prefill+generation throughput, not idle tool time. Reported
 *            only after the turn settles.
 *   2. TTFT — wall-clock from the turn's FIRST HTTP request to its first
 *             text/thinking delta (always the first request's first token).
 *
 * Reset once per agent run (agent_start), including retries — each attempt is
 * an independent streaming window. Token counts come from the provider's usage
 * block (no char-based estimation).
 */

export class TokenSpeedEngine {
  private _isStreaming = false;
  private _finished = false;

  // Turn-level accumulators
  private _firstRequestStartMs = 0; // first before_provider_request of the turn (TTFT anchor)
  private _currentRequestStartMs = 0; // current request's before_provider_request (per-request window)
  private _accumulatedRequestMs = 0; // sum of per-request (http→message_end) durations
  private _accumulatedOutputTokens = 0;

  // TTFT
  private _firstTokenArrived = false;
  private _ttftMs = 0;

  get isStreaming() { return this._isStreaming; }

  /**
   * End-to-end tokens per second for the whole turn.
   *
   * Zero until the turn settles: total output tokens across all requests over
   * the sum of their prefill+generation windows (tool time excluded).
   */
  get tps(): number {
    if (!this._finished || this._accumulatedOutputTokens === 0 || this._accumulatedRequestMs === 0) return 0;
    return this._accumulatedOutputTokens / (this._accumulatedRequestMs / 1000);
  }

  /**
   * TTFT in seconds.
   *
   * Before first token arrives: returns a live (Date.now() - firstRequestStart)
   * value so the status header shows a counting-up timer while the user waits.
   *
   * After first token: returns the frozen measured TTFT (of the first request).
   */
  get ttftSec(): number {
    if (this._firstTokenArrived) return this._ttftMs / 1000;
    const anchor = this._firstRequestStartMs || this._currentRequestStartMs;
    if (this._isStreaming && anchor > 0) {
      return (Date.now() - anchor) / 1000;
    }
    return this._ttftMs / 1000;
  }

  /**
   * Full per-turn reset. Call on agent_start — every agent run (including
   * retries) starts a fresh independent streaming window.
   */
  reset() {
    this._isStreaming = false;
    this._finished = false;
    this._firstRequestStartMs = 0;
    this._currentRequestStartMs = 0;
    this._accumulatedRequestMs = 0;
    this._accumulatedOutputTokens = 0;
    this._firstTokenArrived = false;
    this._ttftMs = 0;
  }

  /**
   * Call on before_provider_request. Marks the current request's start and
   * seeds the turn's first-request anchor on the initial request.
   */
  recordHttpRequest() {
    const now = Date.now();
    this._currentRequestStartMs = now;
    if (this._firstRequestStartMs === 0) this._firstRequestStartMs = now;
  }

  /**
   * Call on message_start (assistant). Marks streaming active. Seeds the
   * anchors as a fallback if before_provider_request was missed.
   */
  start() {
    this._isStreaming = true;
    const now = Date.now();
    if (this._currentRequestStartMs === 0) this._currentRequestStartMs = now;
    if (this._firstRequestStartMs === 0) this._firstRequestStartMs = now;
  }

  /**
   * Call on each text_delta / thinking_delta.
   * Only the first arrival of the turn matters: it freezes TTFT.
   */
  recordToken(_delta: string) {
    if (!this._isStreaming || this._firstTokenArrived) return;
    this._firstTokenArrived = true;
    const anchor = this._firstRequestStartMs || this._currentRequestStartMs;
    this._ttftMs = anchor > 0 ? Date.now() - anchor : 0;
  }

  /**
   * Call on message_end (assistant). Accumulates this request's duration and
   * the provider-reported output token count into the turn totals.
   */
  finish(realOutputTokens?: number) {
    this._isStreaming = false;
    this._finished = true;
    if (this._currentRequestStartMs > 0) {
      this._accumulatedRequestMs += Date.now() - this._currentRequestStartMs;
      this._currentRequestStartMs = 0;
    }
    if (realOutputTokens !== undefined && realOutputTokens > 0) {
      this._accumulatedOutputTokens += realOutputTokens;
    }
  }

  /** Full reset (session_shutdown). */
  stop() {
    this.reset();
  }
}
