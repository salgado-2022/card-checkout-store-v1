terraform {
  # S3 native locking (use_lockfile) requires Terraform 1.10 or newer.
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Partial backend: bucket, key and region are passed with -backend-config
  # by the workflows. No DynamoDB lock table: locking uses the S3 lockfile.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "us-east-1"
}
