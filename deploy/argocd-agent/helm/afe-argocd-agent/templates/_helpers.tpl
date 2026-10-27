{{- define "afe-argocd-agent.name" -}}
afe-argocd-agent
{{- end -}}

{{- define "afe-argocd-agent.labels" -}}
app.kubernetes.io/name: afe-argocd-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "afe-argocd-agent.selector" -}}
app.kubernetes.io/name: afe-argocd-agent
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "afe-argocd-agent.fullname" -}}
{{- printf "%s-afe-argocd-agent" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
