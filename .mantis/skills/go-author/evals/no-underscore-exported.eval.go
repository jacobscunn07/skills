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

const evalID = "no-underscore-exported"
const evalName = "Exported names use MixedCaps not underscores"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Exported identifier containing an underscore: e.g. My_Func, HTTP_Client
	exportedUnderscoreRe = regexp.MustCompile(`\b[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+\b`)
	// Exclude ALL_CAPS constants (iota blocks sometimes use them, though not idiomatic)
	allCapsRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]+$`)
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
	candidates := exportedUnderscoreRe.FindAllString(allCode, -1)

	violations := []string{}
	seen := map[string]bool{}
	for _, c := range candidates {
		if allCapsRe.MatchString(c) {
			continue // tolerate ALL_CAPS constants
		}
		if !seen[c] {
			violations = append(violations, c)
			seen[c] = true
		}
	}

	if len(violations) == 0 {
		emit(1.0, "All exported names use MixedCaps with no underscores.")
		return
	}

	emit(0.1, "Exported names must use MixedCaps, not underscores (found: "+strings.Join(violations, ", ")+").")
}
