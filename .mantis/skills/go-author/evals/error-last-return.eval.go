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

const evalID = "error-last-return"
const evalName = "error is the last return value"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// matches: func Name(...) (error, SomeType) — error NOT last
	errorFirstRe = regexp.MustCompile(`\bfunc\s+\w+[^)]*\)\s*\(\s*error\s*,`)
	// matches: func Name(...) error — single error return is fine
	// matches: func Name(...) (SomeType, error) — error last is fine
	errorLastRe = regexp.MustCompile(`\bfunc\s+\w+[^)]*\)\s*(?:\([^)]*,\s*error\s*\)|error\s*\{)`)
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

	if errorFirstRe.MatchString(allCode) {
		emit(0.0, "Found function(s) returning error as first value — error must be the last return value.")
		return
	}

	if errorLastRe.MatchString(allCode) {
		emit(1.0, "All functions with error returns place error last.")
		return
	}

	emit(0.5, "No functions with error returns found — cannot verify convention.")
}
