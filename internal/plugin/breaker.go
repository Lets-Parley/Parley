package plugin

import "time"

// breaker degrades a plugin that keeps failing and then gives up on it.
//
// Two stages rather than one: a plugin that fails a burst is degraded for a
// cooldown, which is recoverable and costs a few refused calls. A plugin that
// comes back from the cooldown and fails again, repeatedly, is disabled, which
// is not recoverable without an operator. The middle stage exists so a passing
// upstream outage does not permanently uninstall a working plugin, and the
// last stage exists so a broken one stops burning the call budget forever.
type breaker struct {
	threshold int // consecutive failures that degrade the plugin
	tripLimit int // degradations that disable it

	failures int
	trips    int
	// actionFailures counts failed actions on their own, so a room cannot
	// push the count above toward a trip. See Host.record.
	actionFailures int
	openTill       time.Time

	// lastErr and reason are what the operator screen renders. The breaker's
	// state has always been in memory; before this it was also *only* in the
	// log, so a plugin the host had given up on looked, on any screen, exactly
	// like a plugin with nothing to do.
	lastErr string
	reason  string
}

type breakerOutcome int

const (
	breakerHealthy breakerOutcome = iota
	// breakerDegraded means the plugin has just been put in its cooldown.
	breakerDegraded
	// breakerExhausted means it has degraded too many times and must be
	// disabled.
	breakerExhausted
)

// allow reports whether a call may proceed. A degraded plugin is short-
// circuited for its cooldown rather than being called and failing again.
func (b *breaker) allow(now time.Time) bool { return !now.Before(b.openTill) }

func (b *breaker) success() { b.failures, b.actionFailures = 0, 0 }

// failure charges one failure and returns what it changed.
func (b *breaker) failure(now time.Time, cooldown time.Duration) breakerOutcome {
	b.failures++
	if b.failures < b.threshold {
		return breakerHealthy
	}
	b.failures = 0
	b.trips++
	if b.trips >= b.tripLimit {
		return breakerExhausted
	}
	b.openTill = now.Add(cooldown)
	return breakerDegraded
}

// actionFailure charges one failed action. It can open the cooldown and can
// never trip.
func (b *breaker) actionFailure(now time.Time, cooldown time.Duration) breakerOutcome {
	b.actionFailures++
	if b.actionFailures < b.threshold {
		return breakerHealthy
	}
	b.actionFailures = 0
	b.openTill = now.Add(cooldown)
	return breakerDegraded
}
