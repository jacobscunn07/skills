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

const evalID = "no-panic-normal-flow"
const evalName = "No panic for ordinary error flow"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Panicking with an err value or a formatted error string — error-flow panic
	panicErrRe = regexp.MustCompile(`\bpanic\s*\(\s*(?:err|fmt\.(?:Sprintf|Errorf)|errors\.New)`)
	// Acceptable panics: init impossible state, truly unreachable, string literals describing invariants
	panicOKRe = regexp.MustCompile(`\bpanic\s*\(\s*"`)
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

	if panicErrRe.MatchString(allCode) {
		emit(0.1, "Found panic(err) or panic(fmt.Errorf(...)) — use error returns instead of panicking for normal error flow.")
		return
	}

	if panicOKRe.MatchString(allCode) {
		emit(0.8, "Found panic with a string literal — acceptable for impossible/invariant states, but verify it is not in a hot path.")
		return
	}

	emit(1.0, "No error-flow panics detected.")
}
