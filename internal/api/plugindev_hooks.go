package api

import "github.com/go-chi/chi/v5"

// extraPluginMounts is filled by a plugindev-tagged init. The default build
// leaves it empty, so the verification-bypassing install path is not compiled
// into the binary Docker and CI ship.
var extraPluginMounts []func(*app, chi.Router)
