// Package provider defines factories for independently configured usage providers.
package provider

import (
	"context"
	"flag"

	"github.com/suppressio/ia-hypermiler/gocore/internal/usage"
)

// Provider binds account flags and fetches usage without putting secrets in argv.
type Provider interface {
	ID() string
	DisplayName() string
	BindFlags(fs *flag.FlagSet)
	AcceptsSecret() bool
	Fetch(ctx context.Context, secret string) (usage.Usage, error)
}

// Registry creates a fresh provider instance for each CLI run.
type Registry map[string]func() Provider

// Default returns the real binary's providers.
func Default() Registry {
	// #148 adds Codex; #149 adds Copilot. No real provider is registered yet.
	return Registry{}
}
