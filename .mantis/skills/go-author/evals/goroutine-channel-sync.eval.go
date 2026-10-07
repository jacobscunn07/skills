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

const evalID = "goroutine-channel-sync"
const evalName = "Goroutines communicate via channels"

var (
	codeBlockRe  = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	goroutineRe  = regexp.MustCompile(`\bgo\s+(?:func|\w+)\s*[(\[]`)
	chanMakeRe   = regexp.MustCompile(`\bmake\s*\(\s*chan\b`)
	chanSendRe   = regexp.MustCompile(`\w+\s*<-`)
	chanRecvRe   = regexp.MustCompile(`<-\s*\w+`)
	// Raw shared-state patterns with no channel pairing
	globalMutexRe = regexp.MustCompile(`\bsync\.Mutex\b`)
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

	hasGoroutines := goroutineRe.MatchString(allCode)
	if !hasGoroutines {
		emit(0.5, "No goroutines found — concurrency check not applicable to this response.")
		return
	}

	hasChannels := chanMakeRe.MatchString(allCode) || chanSendRe.MatchString(allCode) || chanRecvRe.MatchString(allCode)
	hasMutexOnly := globalMutexRe.MatchString(allCode) && !hasChannels

	if hasChannels {
		if hasMutexOnly {
			emit(0.7, "Goroutines use both channels and mutexes — prefer channels for coordination where possible.")
		} else {
			emit(1.0, "Goroutines communicate via channels.")
		}
		return
	}

	emit(0.1, "Goroutines found but no channel usage detected — share memory by communicating, not by sharing memory.")
}
