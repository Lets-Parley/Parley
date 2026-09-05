package api

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/lets-parley/parley/internal/hub"
)

// metrics is the per-process Prometheus registry and the counters handlers
// increment. A nil receiver is a no-op so the rest of the package can call
// through without checking whether METRICS_ENABLED was set.
type metrics struct {
	registry           *prometheus.Registry
	listenerReconnects prometheus.Counter
	passcodeThrottled  prometheus.Counter
	identityThrottled  prometheus.Counter
}

func newMetrics(pool *pgxpool.Pool, h *hub.Hub) *metrics {
	reg := prometheus.NewRegistry()
	m := &metrics{
		registry: reg,
		listenerReconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "parley_listener_reconnects_total",
			Help: "Times this replica's session-notification LISTEN connection dropped and began reconnecting.",
		}),
		passcodeThrottled: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "parley_passcode_throttled_total",
			Help: "Times a room-code, invite-handle or link-token guess was refused because the caller's budget was spent.",
		}),
		identityThrottled: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "parley_identity_throttled_total",
			Help: "Times open-mode identity creation or link redemption was refused by the hourly identity quota.",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		m.listenerReconnects,
		m.passcodeThrottled,
		m.identityThrottled,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "parley_ws_connections",
			Help: "WebSocket connections currently held by this process.",
		}, func() float64 {
			if h == nil {
				return 0
			}
			return float64(h.Len())
		}),
	)
	if pool != nil {
		reg.MustRegister(newPoolCollector(pool))
	}
	return m
}

func (m *metrics) handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *metrics) incListenerReconnects() {
	if m == nil {
		return
	}
	m.listenerReconnects.Inc()
}

func (m *metrics) incPasscodeThrottled() {
	if m == nil {
		return
	}
	m.passcodeThrottled.Inc()
}

func (m *metrics) incIdentityThrottled() {
	if m == nil {
		return
	}
	m.identityThrottled.Inc()
}

// poolCollector reads pgxpool.Stat on scrape rather than sampling on a timer,
// so a scrape always sees the pool as it is.
type poolCollector struct {
	pool *pgxpool.Pool

	acquiresTotal            *prometheus.Desc
	acquireSecondsTotal      *prometheus.Desc
	acquiredConns            *prometheus.Desc
	canceledAcquiresTotal    *prometheus.Desc
	constructingConns        *prometheus.Desc
	emptyAcquiresTotal       *prometheus.Desc
	idleConns                *prometheus.Desc
	maxConns                 *prometheus.Desc
	totalConns               *prometheus.Desc
	newConnsTotal            *prometheus.Desc
	maxLifetimeDestroysTotal *prometheus.Desc
	maxIdleDestroysTotal     *prometheus.Desc
	emptyAcquireWaitSeconds  *prometheus.Desc
}

func newPoolCollector(pool *pgxpool.Pool) *poolCollector {
	return &poolCollector{
		pool: pool,
		acquiresTotal: prometheus.NewDesc(
			"parley_pgxpool_acquires_total",
			"Successful connection acquires from the pool.",
			nil, nil,
		),
		acquireSecondsTotal: prometheus.NewDesc(
			"parley_pgxpool_acquire_seconds_total",
			"Time spent waiting for a connection from the pool.",
			nil, nil,
		),
		acquiredConns: prometheus.NewDesc(
			"parley_pgxpool_acquired_conns",
			"Connections currently checked out of the pool.",
			nil, nil,
		),
		canceledAcquiresTotal: prometheus.NewDesc(
			"parley_pgxpool_canceled_acquires_total",
			"Acquires canceled before a connection was available.",
			nil, nil,
		),
		constructingConns: prometheus.NewDesc(
			"parley_pgxpool_constructing_conns",
			"Connections the pool is currently constructing.",
			nil, nil,
		),
		emptyAcquiresTotal: prometheus.NewDesc(
			"parley_pgxpool_empty_acquires_total",
			"Acquires that waited because the pool had no idle connection.",
			nil, nil,
		),
		idleConns: prometheus.NewDesc(
			"parley_pgxpool_idle_conns",
			"Idle connections currently in the pool.",
			nil, nil,
		),
		maxConns: prometheus.NewDesc(
			"parley_pgxpool_max_conns",
			"Configured maximum size of the pool.",
			nil, nil,
		),
		totalConns: prometheus.NewDesc(
			"parley_pgxpool_total_conns",
			"Total connections the pool currently holds.",
			nil, nil,
		),
		newConnsTotal: prometheus.NewDesc(
			"parley_pgxpool_new_conns_total",
			"New connections the pool has opened.",
			nil, nil,
		),
		maxLifetimeDestroysTotal: prometheus.NewDesc(
			"parley_pgxpool_max_lifetime_destroys_total",
			"Connections closed because they exceeded max lifetime.",
			nil, nil,
		),
		maxIdleDestroysTotal: prometheus.NewDesc(
			"parley_pgxpool_max_idle_destroys_total",
			"Connections closed because they exceeded max idle time.",
			nil, nil,
		),
		emptyAcquireWaitSeconds: prometheus.NewDesc(
			"parley_pgxpool_empty_acquire_wait_seconds_total",
			"Time spent waiting on an empty pool.",
			nil, nil,
		),
	}
}

func (c *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.acquiresTotal
	ch <- c.acquireSecondsTotal
	ch <- c.acquiredConns
	ch <- c.canceledAcquiresTotal
	ch <- c.constructingConns
	ch <- c.emptyAcquiresTotal
	ch <- c.idleConns
	ch <- c.maxConns
	ch <- c.totalConns
	ch <- c.newConnsTotal
	ch <- c.maxLifetimeDestroysTotal
	ch <- c.maxIdleDestroysTotal
	ch <- c.emptyAcquireWaitSeconds
}

func (c *poolCollector) Collect(ch chan<- prometheus.Metric) {
	stat := c.pool.Stat()
	ch <- prometheus.MustNewConstMetric(c.acquiresTotal, prometheus.CounterValue, float64(stat.AcquireCount()))
	ch <- prometheus.MustNewConstMetric(c.acquireSecondsTotal, prometheus.CounterValue, stat.AcquireDuration().Seconds())
	ch <- prometheus.MustNewConstMetric(c.acquiredConns, prometheus.GaugeValue, float64(stat.AcquiredConns()))
	ch <- prometheus.MustNewConstMetric(c.canceledAcquiresTotal, prometheus.CounterValue, float64(stat.CanceledAcquireCount()))
	ch <- prometheus.MustNewConstMetric(c.constructingConns, prometheus.GaugeValue, float64(stat.ConstructingConns()))
	ch <- prometheus.MustNewConstMetric(c.emptyAcquiresTotal, prometheus.CounterValue, float64(stat.EmptyAcquireCount()))
	ch <- prometheus.MustNewConstMetric(c.idleConns, prometheus.GaugeValue, float64(stat.IdleConns()))
	ch <- prometheus.MustNewConstMetric(c.maxConns, prometheus.GaugeValue, float64(stat.MaxConns()))
	ch <- prometheus.MustNewConstMetric(c.totalConns, prometheus.GaugeValue, float64(stat.TotalConns()))
	ch <- prometheus.MustNewConstMetric(c.newConnsTotal, prometheus.CounterValue, float64(stat.NewConnsCount()))
	ch <- prometheus.MustNewConstMetric(c.maxLifetimeDestroysTotal, prometheus.CounterValue, float64(stat.MaxLifetimeDestroyCount()))
	ch <- prometheus.MustNewConstMetric(c.maxIdleDestroysTotal, prometheus.CounterValue, float64(stat.MaxIdleDestroyCount()))
	ch <- prometheus.MustNewConstMetric(c.emptyAcquireWaitSeconds, prometheus.CounterValue, stat.EmptyAcquireWaitTime().Seconds())
}
