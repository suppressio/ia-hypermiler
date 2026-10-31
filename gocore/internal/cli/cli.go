// Package cli dispatches the binary's subcommands.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"
	"strings"
	"time"

	"github.com/suppressio/ia-hypermiler/gocore/internal/buildinfo"
	"github.com/suppressio/ia-hypermiler/gocore/internal/logging"
	"github.com/suppressio/ia-hypermiler/gocore/internal/provider"
	"github.com/suppressio/ia-hypermiler/gocore/internal/usage"
)

const (
	// ExitOK indicates successful command execution, including stale values.
	ExitOK = 0
	// ExitProviderError indicates a provider failure.
	ExitProviderError = 1
	// ExitUsage indicates invalid command-line arguments.
	ExitUsage      = 2
	maxSecretBytes = 64 * 1024
)

// Env supplies providers, streams and clock without process-global test state.
type Env struct {
	Providers      provider.Registry
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	Now            func() time.Time
	Location       *time.Location
}

// Run executes a subcommand, keeping command output on stdout and logs on stderr.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	return RunWith(Env{provider.Default(), stdin, stdout, stderr, time.Now, time.Local}, args)
}

// RunWith executes a command with isolated provider instances and an injected clock.
func RunWith(env Env, args []string) int {
	logger := logging.New(env.Stderr)
	logger.Debug("Starting CLI", "version", buildinfo.Version)
	jsonMode := wantsJSON(args)
	if len(args) == 0 {
		return usageError(env, jsonMode, "A command is required")
	}
	command := args[0]
	if command == "usage" {
		return runUsage(env, args[1:], jsonMode)
	}
	switch command {
	case "help", "-h", "--help", "version":
	default:
		return usageError(env, jsonMode, "Unknown command: "+command)
	}
	flags := newFlags(command)
	flags.Bool("json", false, "Print the versioned JSON document")
	if err := flags.Parse(args[1:]); err != nil {
		return flagError(env, jsonMode, err)
	}
	if flags.NArg() != 0 {
		return usageError(env, jsonMode, "Unexpected arguments")
	}
	if command != "version" {
		if jsonMode {
			return usageError(env, true, "Help is only available as text")
		}
		printUsage(env.Stdout)
		return ExitOK
	}
	if jsonMode {
		err := json.NewEncoder(env.Stdout).Encode(struct {
			SchemaVersion int    `json:"schemaVersion"`
			Name          string `json:"name"`
			Version       string `json:"version"`
			OS            string `json:"os"`
			Arch          string `json:"arch"`
		}{usage.SchemaVersion, buildinfo.Name, buildinfo.Version, runtime.GOOS, runtime.GOARCH})
		return outputResult(env, err, ExitOK)
	}
	_, err := fmt.Fprintf(env.Stdout, "%s %s (%s/%s)\n", buildinfo.Name, buildinfo.Version, runtime.GOOS, runtime.GOARCH)
	return outputResult(env, err, ExitOK)
}

func runUsage(env Env, args []string, jsonMode bool) int {
	if len(args) == 0 {
		return usageError(env, jsonMode, "A provider is required")
	}
	if args[0] == "--help" || args[0] == "-h" {
		return flagError(env, jsonMode, flag.ErrHelp)
	}
	factory, ok := env.Providers[args[0]]
	if !ok {
		return usageError(env, jsonMode, "Unknown provider: "+args[0])
	}
	p := factory()
	flags := newFlags("usage " + p.ID())
	flags.Bool("json", false, "Print the versioned JSON document")
	timeout := flags.Duration("timeout", 25*time.Second, "Fetch deadline (greater than 0, at most 2m)")
	secretStdin := flags.Bool("secret-stdin", false, "Read the secret from stdin (at most 64 KiB)")
	p.BindFlags(flags)
	if err := flags.Parse(args[1:]); err != nil {
		return flagError(env, jsonMode, err)
	}
	if flags.NArg() != 0 {
		return usageError(env, jsonMode, "Unexpected arguments")
	}
	if *timeout <= 0 || *timeout > 2*time.Minute {
		return usageError(env, jsonMode, "Timeout must be greater than 0 and at most 2m")
	}
	secret := ""
	if *secretStdin {
		if !p.AcceptsSecret() {
			return usageError(env, jsonMode, "Provider does not accept a secret on stdin")
		}
		data, err := io.ReadAll(io.LimitReader(env.Stdin, maxSecretBytes+1))
		if err != nil {
			return usageError(env, jsonMode, "Cannot read secret from stdin")
		}
		if len(data) > maxSecretBytes {
			return usageError(env, jsonMode, "Secret exceeds 64 KiB")
		}
		secret = strings.TrimSuffix(string(data), "\r\n")
		if secret == string(data) {
			secret = strings.TrimSuffix(secret, "\n")
		}
		if secret == "" {
			return usageError(env, jsonMode, "Secret on stdin is empty")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	u, err := p.Fetch(ctx, secret)
	// A provider that wraps or replaces the deadline error still reports a timeout;
	// a result that arrived in time is kept even if the deadline passed just after.
	if err != nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil {
		classified := *usage.ClassifyError(err)
		classified.Message = redact(classified.Message, secret)
		classified.Endpoint = redact(classified.Endpoint, secret)
		if jsonMode {
			return outputResult(env, usage.WriteError(env.Stdout, p.ID(), &classified), ExitProviderError)
		}
		_, _ = fmt.Fprintf(env.Stderr, "%s: %s\n", p.ID(), oneLine(classified.Message))
		return ExitProviderError
	}
	if u.Stale != nil {
		stale := *u.Stale
		stale.Message = redact(stale.Message, secret)
		u.Stale = &stale
	}
	if jsonMode {
		return outputResult(env, usage.WriteSuccess(env.Stdout, p.ID(), u, env.Now()), ExitOK)
	}
	var text strings.Builder
	usage.RenderText(&text, p.DisplayName(), u, env.Now(), env.Location)
	_, err = io.WriteString(env.Stdout, text.String())
	return outputResult(env, err, ExitOK)
}

func newFlags(command string) *flag.FlagSet {
	flags := flag.NewFlagSet(buildinfo.Name+" "+command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.Usage = func() {}
	return flags
}

func flagError(env Env, jsonMode bool, err error) int {
	if errors.Is(err, flag.ErrHelp) && !jsonMode {
		printUsage(env.Stdout)
		return ExitOK
	}
	return usageError(env, jsonMode, err.Error())
}

func usageError(env Env, jsonMode bool, message string) int {
	if jsonMode {
		return outputResult(env, usage.WriteError(env.Stdout, "", &usage.Error{Code: usage.CodeUsage, Message: message}), ExitUsage)
	}
	_, _ = fmt.Fprintln(env.Stderr, oneLine(message))
	printUsage(env.Stderr)
	return ExitUsage
}

func outputResult(env Env, err error, code int) int {
	if err != nil {
		_, _ = fmt.Fprintf(env.Stderr, "Cannot write output: %s\n", oneLine(err.Error()))
		return ExitProviderError
	}
	return code
}

func wantsJSON(args []string) bool {
	for _, arg := range args {
		if arg == "--json" || arg == "-json" || strings.HasPrefix(arg, "--json=") || strings.HasPrefix(arg, "-json=") {
			return true
		}
	}
	return false
}

func redact(message, secret string) string {
	if secret != "" {
		return strings.ReplaceAll(message, secret, "[redacted]")
	}
	return message
}

func oneLine(message string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(message)
}

func printUsage(w io.Writer) {
	_, _ = fmt.Fprintf(w, "Usage: %s <command>\n\nCommands:\n  usage <provider> [flags]  Fetch account usage\n  version [--json]         Print version and platform\n  help                     Show this help\n\nUsage flags:\n  --json                Print the versioned JSON document\n  --timeout <duration>  Fetch deadline (default 25s, greater than 0, at most 2m)\n  --secret-stdin        Read a secret from stdin (at most 64 KiB, if supported)\n", buildinfo.Name)
}
