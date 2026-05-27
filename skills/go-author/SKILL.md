---
name: go-author
description: Use when writing, reviewing, or refactoring Go (golang) code — authoring HTTP servers, goroutines and channels, concurrent pipelines, file processors, custom error types, interfaces, structs/methods, or any .go file. Triggers on tasks involving idiomatic Go style (gofmt, MixedCaps, package naming, -er interfaces), error handling with wrapping, defer cleanup, append/slice/map usage, select/goroutine synchronization, and panic/recover decisions.
version: 1
---

# Go Authoring Skill

Idiomatic Go authoring rules. Apply to every `.go` file you write or modify.

## CRITICAL: Always Deliver Complete Runnable Code

When the user asks you to "write", "implement", "create", or "build" Go code, you MUST output the **complete, compilable Go source file** inside a ```go fenced code block — including:

1. `package` declaration (lowercase, single word)
2. All needed `import` statements
3. Every requested function with its full body (not a sketch, not pseudocode, not just signatures)
4. A `main` function when the task implies a runnable program
5. Exported doc comments starting with the identifier name

**Do NOT** reply with only a design summary, only filenames, only snippets, or only bullet points describing what the code would do. Show the actual code first, then optionally add a short explanation after.

If the user asks for multiple files, output each in its own ```go block with a header comment `// file: path/name.go`.

## Quick Decision Matrix

| Situation | Do | Don't |
|---|---|---|
| Function can fail | Return `(T, error)` as last value | Sentinel values, output pointers, `panic` |
| Getter for field `owner` | `func (x *X) Owner() string` | `GetOwner()` |
| Exported multi-word name | `MixedCaps` (`ParseURL`) | `Parse_URL`, `parse_url` |
| Package name for `encoding/base64` | `package base64` | `package Base64`, `package base_64` |
| Single-method interface | Name with `-er` suffix: `Reader`, `Stringer`, `Closer` | `IReader`, `ReadInterface` |
| Opening brace placement | Same line as `if`/`for`/`func` | Newline before `{` (syntax error) |
| Cleanup after open | `defer f.Close()` immediately after err check | Manual close at every return path |
| Goroutine result delivery | Send on channel; receiver `range`s or `select`s | Shared mutable variable + mutex (when channel works) |
| `append` to slice | `s = append(s, v)` — always reassign | `append(s, v)` discarded |
| Error context | Custom error type or `fmt.Errorf("op %s: %w", path, err)` | Bare `return err` with no context at boundaries |
| Unrecoverable bug | `panic` | Use for normal error flow |

## Formatting

- Run `gofmt`/`goimports`. Tabs for indent. No line-length limit.
- Opening brace MUST be on the same line as the control structure — semicolon insertion makes `if x\n{` a syntax error.

```go
// ✅
if i < f() {
    g()
}

// ❌ syntax error
if i < f()
{
    g()
}
```

## Naming

### Packages
- **Lowercase, single word, no underscores, no mixedCaps.** `package httputil`, not `package HTTPUtil` or `package http_util`.
- Base directory name = package name. `src/encoding/base64` → `package base64`.
- Don't stutter: `bufio.Reader`, not `bufio.BufReader`; `http.Server`, not `http.HTTPServer`.

### Identifiers
- `MixedCaps` (exported) or `mixedCaps` (unexported). **Never** underscores in exported names — `ParseRequest`, never `Parse_Request`.
- Acronyms keep case: `ServeHTTP`, `userID`, `parseURL`.
- Getters drop `Get`: field `owner` → method `Owner()`. Setter is `SetOwner(v)`.

### Interfaces
- One method → method-name + `-er`: `Reader`, `Writer`, `Closer`, `Stringer`, `Formatter`.
- If your method matches a stdlib signature (`Read([]byte) (int, error)`, `String() string`, `Close() error`), use that exact name.

## Errors

### Convention
- Error is the **last** return value: `func Open(name string) (*File, error)`.
- Check errors immediately. Guard pattern — handle the failure, then proceed with the happy path with no `else`.

### Custom error types template (always show the full type)

```go
package fsutil

import "fmt"

// PathError records an error and the operation and file path that caused it.
type PathError struct {
    Op   string
    Path string
    Err  error
}

func (e *PathError) Error() string {
    return fmt.Sprintf("%s %s: %v", e.Op, e.Path, e.Err)
}

func (e *PathError) Unwrap() error { return e.Err }
```

Callers use `errors.As(err, &pe)` or `errors.Is(err, fs.ErrNotExist)`.

### panic / recover
- `panic` only for **truly unrecoverable** programmer errors (invariant violations, init failures).
- Never use `panic` for expected failures (missing file, bad input, network error) — return an error.
- `recover` only inside `defer`; never let panics cross a public API boundary.

## File Processor Template — copy and adapt

```go
package main

import (
    "bufio"
    "fmt"
    "os"
)

// ReadLines returns the lines of the named file, excluding the trailing newline.
// It returns a non-nil error wrapping the underlying cause on any failure.
func ReadLines(path string) ([]string, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("open %s: %w", path, err)
    }
    defer f.Close()

    var lines []string
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        lines = append(lines, scanner.Text())
    }
    if err := scanner.Err(); err != nil {
        return nil, fmt.Errorf("scan %s: %w", path, err)
    }
    return lines, nil
}

func main() {
    lines, err := ReadLines(os.Args[1])
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
    for _, l := range lines {
        fmt.Println(l)
    }
}
```

## Concurrent Word Count Template

```go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"
    "sync"
)

type result struct {
    counts map[string]int
    err    error
}

func countFile(path string) result {
    f, err := os.Open(path)
    if err != nil {
        return result{err: fmt.Errorf("open %s: %w", path, err)}
    }
    defer f.Close()

    counts := make(map[string]int)
    scanner := bufio.NewScanner(f)
    scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
    scanner.Split(bufio.ScanWords)
    for scanner.Scan() {
        counts[strings.ToLower(scanner.Text())]++
    }
    if err := scanner.Err(); err != nil {
        return result{err: fmt.Errorf("scan %s: %w", path, err)}
    }
    return result{counts: counts}
}

// CountWords concurrently counts word frequencies across files.
func CountWords(files []string) (map[string]int, error) {
    results := make(chan result, len(files))
    var wg sync.WaitGroup
    for _, path := range files {
        wg.Add(1)
        go func(p string) {
            defer wg.Done()
            results <- countFile(p)
        }(path)
    }
    go func() { wg.Wait(); close(results) }()

    total := make(map[string]int)
    for r := range results {
        if r.err != nil {
            return nil, r.err
        }
        for k, v := range r.counts {
            total[k] += v
        }
    }
    return total, nil
}

func main() {
    total, err := CountWords(os.Args[1:])
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
    for w, n := range total {
        fmt.Printf("%s\t%d\n", w, n)
    }
}
```

Notes: only the closer goroutine closes `results`; buffered channel sized to `len(files)` avoids blocking when callers return early on error.

## HTTP Server Template

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    fmt.Fprintln(w, "ok")
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", healthHandler)

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    errs := make(chan error, 1)
    go func() {
        if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errs <- fmt.Errorf("listen: %w", err)
        }
        close(errs)
    }()

    sigs := make(chan os.Signal, 1)
    signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errs:
        log.Fatal(err)
    case <-sigs:
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        if err := srv.Shutdown(ctx); err != nil {
            log.Fatalf("shutdown: %v", err)
        }
    }
}
```

## Data Pipeline Template (stages over channels)

```go
package main

import (
    "fmt"
    "sync"
)

func gen(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}

func sq(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            out <- n * n
        }
    }()
    return out
}

func merge(cs ...<-chan int) <-chan int {
    var wg sync.WaitGroup
    out := make(chan int)
    output := func(c <-chan int) {
        defer wg.Done()
        for n := range c {
            out <- n
        }
    }
    wg.Add(len(cs))
    for _, c := range cs {
        go output(c)
    }
    go func() { wg.Wait(); close(out) }()
    return out
}

func main() {
    in := gen(2, 3, 4)
    c1 := sq(in)
    c2 := sq(gen(5, 6))
    for v := range merge(c1, c2) {
        fmt.Println(v)
    }
}
```

## Interface Design Template

```go
package store

import (
    "errors"
    "sync"
)

var ErrNotFound = errors.New("store: key not found")

// Getter retrieves a value by key.
type Getter interface {
    Get(key string) (string, error)
}

// Putter stores a value by key.
type Putter interface {
    Put(key, value string) error
}

// GetPutter composes Getter and Putter.
type GetPutter interface {
    Getter
    Putter
}

// MemStore is an in-memory thread-safe GetPutter.
type MemStore struct {
    mu sync.RWMutex
    m  map[string]string
}

func NewMemStore() *MemStore { return &MemStore{m: make(map[string]string)} }

func (s *MemStore) Get(key string) (string, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.m[key]
    if !ok {
        return "", ErrNotFound
    }
    return v, nil
}

func (s *MemStore) Put(key, value string) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.m[key] = value
    return nil
}

var _ GetPutter = (*MemStore)(nil) // compile-time interface check
```

## Control Flow

- `for` is the only loop. Forms: `for init; cond; post {}`, `for cond {}`, `for {}`.
- `range` for slices/maps/strings/channels. Ranging a string yields `(index, rune)`.
- `switch` has no fallthrough; cases can be comma lists; `switch {` with `case cond:` replaces if-else chains.
- Type switch: `switch v := x.(type) { case T1: ...; case T2: ... }`.

## Functions, defer, returns

- Prefer multiple returns `(value, error)` over output pointers.
- `defer` runs LIFO at function exit; arguments evaluated **at the defer statement**.
- Use `defer` for `Close`, `Unlock`, `Done`, response body cleanup. Put it on the line after the successful acquisition.

## Data

| Need | Use |
|---|---|
| Zeroed `*T` for any type | `new(T)` → returns `*T` |
| Initialized slice/map/channel | `make([]T, n)`, `make(map[K]V)`, `make(chan T, n)` |
| Construct struct | Composite literal `&Foo{A: 1, B: 2}` |
| Append to slice | `s = append(s, v)` or `s = append(s, other...)` |
| Key absence check | `v, ok := m[k]` |

- Design types so the **zero value is useful** (`sync.Mutex`, `bytes.Buffer`).
- Slices are reference-like; arrays are values (assignment copies).

## Methods & Receivers

- Pointer receiver if: method mutates the receiver, the type is large, or for consistency.
- **Be consistent within a type** — don't mix value and pointer receivers.

## Interfaces

- Implicit satisfaction — no `implements` keyword.
- **Small interfaces.** Single-method `-er` interfaces compose best.
- **Accept interfaces, return concrete types.**
- Interface value is `nil` only when **both** type and value are nil.

## Concurrency Rules

> Do not communicate by sharing memory; share memory by communicating.

- **Only the sender closes a channel.** Closing a channel that still has senders panics.
- `for v := range ch` exits when the channel is closed.
- For fan-out workers writing to one channel, use `sync.WaitGroup` and have a single goroutine `wg.Wait()` then `close(ch)`.
- `select` picks whichever case is ready; `default` makes it non-blocking. Use for timeouts (`<-time.After(...)`), cancellation (`<-ctx.Done()`), fan-in.

## Doc comments

- Every exported declaration gets a comment **starting with its name**: `// Parse reads ...`, `// Server handles ...`.
- Place immediately above the declaration, no blank line.

## Blank identifier

- Discard return: `_, err := os.Stat(p)`
- Side-effect import: `import _ "net/http/pprof"`
- Compile-time interface assertion: `var _ io.Reader = (*MyReader)(nil)`

## Key Principles

1. **Always output complete runnable code** — never just a design summary.
2. Simplicity over cleverness.
3. Errors are values — return them, wrap with context, never swallow.
4. Composition (embedding + small interfaces) over inheritance.
5. Communicate via channels; share via communication.
6. Zero values should be useful.
7. Document every exported identifier.
