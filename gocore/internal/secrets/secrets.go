// Package secrets keeps provider credentials in the OS keyring (Windows Credential
// Manager, macOS Keychain, Secret Service on Linux), decided on #179: the core owns
// the Copilot token, so it never crosses argv, the JSON documents or the Electron
// store. There is no file fallback: an unavailable keyring is an explicit error.
package secrets

import (
	"errors"
	"fmt"
	"regexp"
	"sync"

	"github.com/zalando/go-keyring"

	"github.com/suppressio/ia-hypermiler/gocore/internal/buildinfo"
)

// ErrNotFound means no secret is stored under the key (account not connected).
var ErrNotFound = errors.New("secret not found")

// Store reads and writes secrets by key.
type Store interface {
	Get(key string) (string, error)
	Set(key, value string) error
	// Delete removes the secret; deleting a missing one is not an error.
	Delete(key string) error
}

var accountID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// ValidAccount reports whether id can name a keyring entry: the Electron account ids
// ("copilot", "copilot-1a2b3c4d") and nothing that could address another entry.
func ValidAccount(id string) bool { return accountID.MatchString(id) }

// CopilotKey is the keyring entry of a Copilot account's token.
func CopilotKey(account string) string { return "copilot/" + account }

// OSKeyring is the real store, under the service name of the binary.
type OSKeyring struct{}

// Get reads a secret; ErrNotFound when there is none.
func (OSKeyring) Get(key string) (string, error) {
	value, err := keyring.Get(buildinfo.Name, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("OS keyring: %w", err)
	}
	return value, nil
}

// Set stores a secret, replacing any previous value.
func (OSKeyring) Set(key, value string) error {
	if err := keyring.Set(buildinfo.Name, key, value); err != nil {
		return fmt.Errorf("OS keyring: %w", err)
	}
	return nil
}

// Delete removes a secret; a missing one is fine.
func (OSKeyring) Delete(key string) error {
	err := keyring.Delete(buildinfo.Name, key)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("OS keyring: %w", err)
	}
	return nil
}

// Memory is an in-process store for tests.
type Memory struct {
	mu     sync.Mutex
	values map[string]string
	// Err, when set, is returned by every call (an unavailable keyring).
	Err error
}

// Get reads a secret; ErrNotFound when there is none.
func (m *Memory) Get(key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return "", m.Err
	}
	value, ok := m.values[key]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

// Set stores a secret.
func (m *Memory) Set(key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	if m.values == nil {
		m.values = map[string]string{}
	}
	m.values[key] = value
	return nil
}

// Delete removes a secret.
func (m *Memory) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	delete(m.values, key)
	return nil
}
