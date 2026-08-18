{{- define "parley.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "parley.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "parley.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "parley.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "parley.selectorLabels" -}}
app.kubernetes.io/name: {{ include "parley.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "parley.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "parley.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The image tag, defaulting to the chart's appVersion.

Rolling back onto an image older than the migrations that already ran makes
Parley refuse to start, by design. A moving tag makes that rollback happen by
accident — you upgrade the cluster, the tag has moved, and you have no record of
what was deployed. Refuse to render one.

This is a convenience guard, not the safety net: a digest pin resolving to an
old image is not caught here. Parley's own newer-schema refusal is what actually
protects the database.
*/}}
{{- define "parley.imageTag" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if not $tag -}}
{{- fail "image.tag is empty and the chart has no appVersion — pin a published Parley version, e.g. --set image.tag=0.2.1" -}}
{{- end -}}
{{- if has $tag (list "latest" "main" "master" "dev" "edge" "nightly") -}}
{{- fail (printf "image.tag %q is a moving tag. Pin a published version instead, e.g. --set image.tag=%s. Rolling back onto an image older than the migrations that have already run makes Parley refuse to start." $tag .Chart.AppVersion) -}}
{{- end -}}
{{- $tag -}}
{{- end -}}

{{/*
The name of the secret holding DATABASE_URL. Required: there is no default and
no bundled Postgres, so an unset value must fail loudly at render rather than
produce a Deployment pointing at a secret named "".
*/}}
{{- define "parley.databaseSecret" -}}
{{- required "database.existingSecret is required — create a secret holding the Postgres connection string and name it here:\n\n  kubectl create secret generic parley --from-literal=database-url='postgres://parley:secret@host:5432/parley'\n  helm install parley ... --set database.existingSecret=parley\n" .Values.database.existingSecret -}}
{{- end -}}

{{/*
Parley's realtime hub is in-process, enforced by a Postgres advisory lock at
boot: a second replica refuses to start. Rendering one would produce a
Deployment that can never become healthy, so fail at render instead.
*/}}
{{- define "parley.checkReplicas" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail (printf "replicaCount is %d, but Parley is currently single-replica: the realtime hub is in-process and a second pod refuses to start (Postgres advisory lock at boot). Multi-replica support is tracked at https://github.com/lets-parley/parley — until it lands, replicaCount must be 1." (int .Values.replicaCount)) -}}
{{- end -}}
{{- end -}}
