variable "github_owner" {
  description = "GitHub organization or user that owns the repository (used by the deploy role trust policy)."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (used by the deploy role trust policy)."
  type        = string
}

variable "github_owner_id" {
  description = "Numeric id of the GitHub owner, part of the OIDC subject claim (gh api users/<owner> --jq .id)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be the numeric GitHub owner id."
  }
}

variable "github_repo_id" {
  description = "Numeric id of the GitHub repository, part of the OIDC subject claim (gh api repos/<owner>/<repo> --jq .id)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repo_id))
    error_message = "github_repo_id must be the numeric GitHub repository id."
  }
}

variable "state_bucket_name" {
  description = "Globally unique name of the S3 bucket that stores the remote Terraform state of infra/."
  type        = string
}

variable "project_name" {
  description = "Project name used as the prefix of every resource name managed by the deploy role."
  type        = string
}
