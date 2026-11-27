variable "project_name" {
  description = "Prefix for resource names and SSM parameter paths."
  type        = string
  default     = "card-checkout-store"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,40}$", var.project_name))
    error_message = "project_name must be 3 to 40 characters: lowercase letters, digits and hyphens."
  }
}

variable "budget_notification_email" {
  description = "Email address that receives AWS Budgets alerts. Required, no default."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_notification_email))
    error_message = "budget_notification_email must be a valid email address."
  }
}

variable "payment_api_url" {
  description = "Base URL of the payment provider API. Used in the CSP connect-src header."
  type        = string

  validation {
    condition     = can(regex("^https://", var.payment_api_url))
    error_message = "payment_api_url must start with https://."
  }
}

variable "payment_public_key" {
  description = "Public payment key (non-secret). The API config rejects keys without the pub_ prefix."
  type        = string
  default     = "pub_test_placeholder"

  validation {
    condition     = can(regex("^pub_", var.payment_public_key))
    error_message = "payment_public_key must start with pub_ and must never be a private key."
  }
}

variable "lambda_artifact_path" {
  description = "Optional path to a prebuilt Lambda zip. When null, Terraform uses a placeholder zip."
  type        = string
  default     = null
}

variable "origin_secret_rotation" {
  description = "Rotation counter for the origin secret. Change the value in a pull request to generate a new secret."
  type        = string
  default     = "1"
}
