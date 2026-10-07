package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

type scenario struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
}

type evalContext struct {
	Scenario          scenario `json:"scenario"`
	QualityTranscript string   `json:"qualityTranscript"`
	Invoked           bool     `json:"invoked"`
}

type evalResult struct {
	EvalID    string  `json:"evalId"`
	Name      string  `json:"name"`
	Score     float64 `json:"score"`
	Reasoning string  `json:"reasoning"`
}

const evalID = "defer-resource-cleanup"
const evalName = "defer used for resource cleanup"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Resource acquisition patterns
	openRe = regexp.MustCompile(`\b(?:os\.Open|os\.Create|os\.OpenFile|sql\.Open|net\.Dial|http\.Get|bufio\.NewReader)\s*\(`)
	lockRe = regexp.MustCompile(`\.\s*Lock\s*\(\s*\)`)
	// Defer cleanup patterns
	deferCloseRe  = regexp.MustCompile(`\bdefer\b.+\.Close\s*\(\s*\)`)
	deferUnlockRe = regexp.MustCompile(`\bdefer\b.+\.Unlock\s*\(\s*\)`)
)

func extractCodeBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		blocks = append(blocks, m[1])
	}
	return blocks
}

func emit(score float64, reasoning string) {
	json.NewEncoder(os.Stdout).Encode(evalResult{
		EvalID:    evalID,
		Name:      evalName,
		Score:     score,
		Reasoning: reasoning,
	})
}

func main() {
	var ctx evalContext
	if err := json.NewDecoder(os.Stdin).Decode(&ctx); err != nil {
		os.Stderr.WriteString("decode: " + err.Error() + "\n")
		os.Exit(1)
	}

	if !ctx.Invoked || ctx.QualityTranscript == "" {
		emit(0.0, "Skipped — skill not invoked.")
		return
	}

	blocks := extractCodeBlocks(ctx.QualityTranscript)
	allCode := strings.Join(blocks, "\n")

	hasOpen := openRe.MatchString(allCode)
	hasLock := lockRe.MatchString(allCode)
	hasDeferClose := deferCloseRe.MatchString(allCode)
	hasDeferUnlock := deferUnlockRe.MatchString(allCode)

	needsDefer := hasOpen || hasLock
	if !needsDefer {
		emit(0.5, "No resource acquisition detected — defer check not applicable.")
		return
	}

	allCovered := true
	var reasons []string
	if hasOpen && !hasDeferClose {
		allCovered = false
		reasons = append(reasons, "file/connection opened but no defer .Close() found")
	}
	if hasLock && !hasDeferUnlock {
		allCovered = false
		reasons = append(reasons, "mutex locked but no defer .Unlock() found")
	}

	if allCovered {
		emit(1.0, "Resources are properly cleaned up with defer.")
		return
	}

	emit(0.2, "Resource cleanup missing: "+strings.Join(reasons, "; ")+".")
}
