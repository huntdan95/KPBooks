# Terraform — GCP infrastructure for KPBooks

## First apply

```bash
cd infra/terraform
gcloud auth application-default login
terraform init
terraform apply -var="project_id=kpbooks-91c48"
```

What this provisions in Phase 0:

- Cloud SQL Postgres 16 instance (`kpbooks` DB, `kpbooks` user, generated password)
- Artifact Registry Docker repo (`kpbooks`)
- Service accounts: `kpbooks-api`, `kpbooks-worker`, `kpbooks-ci`
- IAM bindings for those service accounts
- Secret Manager secrets: `kpbooks-database-url`, `kpbooks-anthropic-api-key`
- Cloud Storage bucket for attachments (`<project>-attachments`)
- Required APIs enabled

## Populating secrets after apply

`kpbooks-anthropic-api-key` is created empty; add a version manually after your friends generate the key in console.anthropic.com:

```bash
echo -n "sk-ant-..." | gcloud secrets versions add kpbooks-anthropic-api-key --data-file=-
```

## What's NOT in here yet

- Cloud Run service (added when the API is dockerized + first deployed via cloudbuild.yaml)
- VPC + private IP for Cloud SQL (production hardening, Phase 4)
- Cloud Tasks queues (added with the worker service in Phase 1+)
- Cloud KMS CMEK keys (Phase 0 hardening, before going live)
