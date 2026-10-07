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

const evalID = "error-context-wrapping"
const evalName = "Errors include context and wrap the cause"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// fmt.Errorf with %w — correct wrapping
	fmtErrorfWrapRe = regexp.MustCompile(`fmt\.Errorf\s*\([^)]*%w`)
	// fmt.Errorf without %w — context but no chain
	fmtErrorfNoWrapRe = regexp.MustCompile(`fmt\.Errorf\s*\(`)
	// errors.New — bare, no context beyond the literal
	errorsNewRe = regexp.MustCompile(`errors\.New\s*\(\s*"[^"]{1,15}"\s*\)`)
	// Custom error type with Error() method — full credit
	customErrTypeRe = regexp.MustCompile(`func\s*\(\s*\w+\s+\*?\w+[Ee]rr\w*\)\s*Error\s*\(\s*\)\s*string`)
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

	if customErrTypeRe.MatchString(allCode) {
		emit(1.0, "Custom error type with Error() method provides full context and wrapping.")
		return
	}

	if fmtErrorfWrapRe.MatchString(allCode) {
		emit(1.0, "fmt.Errorf with %w correctly wraps errors with context.")
		return
	}

	if fmtErrorfNoWrapRe.MatchString(allCode) {
		emit(0.6, "fmt.Errorf adds context but does not wrap the cause with %w — callers cannot use errors.Is/As on the chain.")
		return
	}

	if errorsNewRe.MatchString(allCode) {
		emit(0.3, "errors.New used with short literal — include the operation name and relevant identifiers in the error message.")
		return
	}

	emit(0.5, "No error creation patterns found — cannot evaluate error context.")
}
