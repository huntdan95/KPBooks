# KPBooks GCP infrastructure — Phase 0 skeleton.
#
# Apply with:
#   terraform init
#   terraform apply -var="project_id=kpbooks-91c48"
#
# This is intentionally minimal. We add resources as we need them; auto-generating
# the full prod topology before the app exists creates surface area we don't use.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project ID (e.g. kpbooks-91c48)"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "db_tier" {
  type        = string
  default     = "db-g1-small"
  description = "Cloud SQL machine tier. Bump to db-custom-* before production."
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ─── APIs we need enabled ────────────────────────────────────────────────────
resource "google_project_service" "services" {
  for_each = toset([
    "sqladmin.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudtasks.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "servicenetworking.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ─── Artifact Registry repo for the API container ────────────────────────────
resource "google_artifact_registry_repository" "kpbooks" {
  location      = var.region
  repository_id = "kpbooks"
  format        = "DOCKER"
  description   = "KPBooks container images"
  depends_on    = [google_project_service.services]
}

# ─── Service accounts ────────────────────────────────────────────────────────
resource "google_service_account" "api" {
  account_id   = "kpbooks-api"
  display_name = "KPBooks API (Cloud Run)"
}

resource "google_service_account" "worker" {
  account_id   = "kpbooks-worker"
  display_name = "KPBooks Worker (Cloud Run jobs)"
}

resource "google_service_account" "ci" {
  account_id   = "kpbooks-ci"
  display_name = "KPBooks Cloud Build"
}

# ─── Cloud SQL (Postgres 16) ─────────────────────────────────────────────────
resource "google_sql_database_instance" "main" {
  name             = "kpbooks"
  database_version = "POSTGRES_16"
  region           = var.region
  depends_on       = [google_project_service.services]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_autoresize   = true
    disk_size         = 20

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7
    }

    ip_configuration {
      ipv4_enabled = true
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  deletion_protection = true
}

resource "google_sql_database" "kpbooks" {
  name     = "kpbooks"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "kpbooks_user" {
  length  = 32
  special = true
}

resource "google_sql_user" "kpbooks" {
  name     = "kpbooks"
  instance = google_sql_database_instance.main.name
  password = random_password.kpbooks_user.result
}

# ─── Secret Manager ──────────────────────────────────────────────────────────
resource "google_secret_manager_secret" "database_url" {
  secret_id  = "kpbooks-database-url"
  depends_on = [google_project_service.services]
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgres://kpbooks:${random_password.kpbooks_user.result}@/kpbooks?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

# Anthropic API key — populated outside Terraform via:
#   gcloud secrets create kpbooks-anthropic-api-key
#   echo -n "sk-ant-..." | gcloud secrets versions add kpbooks-anthropic-api-key --data-file=-
resource "google_secret_manager_secret" "anthropic_api_key" {
  secret_id  = "kpbooks-anthropic-api-key"
  depends_on = [google_project_service.services]
  replication {
    auto {}
  }
}

# ─── IAM ─────────────────────────────────────────────────────────────────────
resource "google_project_iam_member" "api_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "api_db_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_anthropic" {
  secret_id = google_secret_manager_secret.anthropic_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "ci_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_member" "ci_artifact" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_service_account_iam_member" "ci_act_as_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci.email}"
}

# ─── Cloud Storage bucket for receipts/attachments ───────────────────────────
resource "google_storage_bucket" "attachments" {
  name                        = "${var.project_id}-attachments"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  versioning { enabled = true }

  lifecycle_rule {
    condition {
      age                = 365
      with_state         = "ARCHIVED"
    }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "api_attachments" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# ─── Outputs ─────────────────────────────────────────────────────────────────
output "cloudsql_connection_name" {
  value       = google_sql_database_instance.main.connection_name
  description = "Pass this to Cloud Run --add-cloudsql-instances"
}

output "api_service_account" {
  value = google_service_account.api.email
}

output "ci_service_account" {
  value = google_service_account.ci.email
}

output "attachments_bucket" {
  value = google_storage_bucket.attachments.name
}
