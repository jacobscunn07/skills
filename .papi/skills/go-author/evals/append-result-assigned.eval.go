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

const evalID = "append-result-assigned"
const evalName = "append result is always assigned"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Line that calls append but is NOT part of an assignment or return
	// Bare append: starts with optional whitespace then "append(" — not preceded by =, :=, return, or (
	bareAppendRe = regexp.MustCompile(`(?m)^\s+append\s*\(`)
	// append used correctly on the right side of = or :=
	assignedAppendRe = regexp.MustCompile(`(?:=|:=)\s*append\s*\(`)
	// append in a return statement
	returnAppendRe = regexp.MustCompile(`\breturn\b[^)]*\bappend\s*\(`)
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

	allCode := strings.Join(extractCodeBlocks(ctx.QualityTranscript), "\n")

	hasAnyAppend := strings.Contains(allCode, "append(")
	if !hasAnyAppend {
		emit(0.5, "No append calls found — check not applicable.")
		return
	}

	if bareAppendRe.MatchString(allCode) {
		emit(0.0, "Found append(...) call whose result is not assigned — append returns the updated slice, always assign it back.")
		return
	}

	if assignedAppendRe.MatchString(allCode) || returnAppendRe.MatchString(allCode) {
		emit(1.0, "All append calls have their result properly assigned.")
		return
	}

	emit(0.5, "append present but assignment pattern unclear — verify result is captured.")
}
