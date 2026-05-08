# Terraform — GCP infrastructure for KPBooks

## First apply

```bash
cd infra/terraform
gcloud auth application-default login
terraform init
terraform apply -var="project_id=kpbooks-91c48"
```

What this provisions in Phase 0:

- Artifact Registry Docker repo (`kpbooks`)
- Service accounts: `kpbooks-api`, `kpbooks-worker`, `kpbooks-ci`
- IAM bindings for those service accounts
- Secret Manager secrets: `kpbooks-database-url`, `kpbooks-anthropic-api-key` (values populated outside Terraform)
- Cloud Storage bucket for attachments (`<project>-attachments`)
- Required APIs enabled

Postgres lives outside GCP (currently Neon). The Cloud Run API reaches it via the connection string stored in the `kpbooks-database-url` secret.

## Populating secrets after apply

Both secrets are created empty; add versions manually:

```bash
# Database URL (Neon connection string)
echo -n "postgresql://..." | gcloud secrets versions add kpbooks-database-url --data-file=-

# Anthropic API key
echo -n "sk-ant-..." | gcloud secrets versions add kpbooks-anthropic-api-key --data-file=-
```

## What's NOT in here yet

- Cloud Run service (added when the API is dockerized + first deployed via cloudbuild.yaml)
- Cloud Tasks queues (added with the worker service in Phase 1+)
- Cloud KMS CMEK keys (Phase 0 hardening, before going live)
