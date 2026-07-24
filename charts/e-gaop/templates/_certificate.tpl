apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ include "e-gaop.fullname" . }}-{{ .Values.serviceName }}-tls
  namespace: {{ .Release.Namespace }}
spec:
  secretName: {{ .Values.serviceName }}-tls
  duration: 24h
  renewBefore: 4h
  subject:
    organizations:
      - egaop.io
  dnsNames:
    - {{ .Values.serviceName }}.{{ .Release.Namespace }}.svc.cluster.local
    - {{ .Values.serviceName }}
  issuerRef:
    name: {{ include "e-gaop.fullname" . }}-internal-ca
    kind: ClusterIssuer
