variable "github_owner" {
  description = "GitHub organization or user that owns the repository (used by the deploy role trust policy)."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (used by the deploy role trust policy)."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally unique name of the S3 bucket that stores the remote Terraform state of infra/."
  type        = string
}

variable "project_name" {
  description = "Project name used as the prefix of every resource name managed by the deploy role."
  type        = string
}
