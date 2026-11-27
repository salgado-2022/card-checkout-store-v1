# Five business tables in provisioned capacity (AWS always-free tier).
# Capacity totals: 12 RCU / 12 WCU, including the two GSIs.
# No autoscaling and no point-in-time recovery, by design.

resource "aws_dynamodb_table" "products" {
  name           = "${var.project_name}-products"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 1
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "customers" {
  name           = "${var.project_name}-customers"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 2
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  global_secondary_index {
    name            = "email"
    hash_key        = "email"
    projection_type = "ALL"
    read_capacity   = 1
    write_capacity  = 1
  }
}

resource "aws_dynamodb_table" "transactions" {
  name           = "${var.project_name}-transactions"
  billing_mode   = "PROVISIONED"
  read_capacity  = 3
  write_capacity = 3
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "reference"
    type = "S"
  }

  global_secondary_index {
    name            = "reference"
    hash_key        = "reference"
    projection_type = "ALL"
    read_capacity   = 1
    write_capacity  = 1
  }
}

resource "aws_dynamodb_table" "deliveries" {
  name           = "${var.project_name}-deliveries"
  billing_mode   = "PROVISIONED"
  read_capacity  = 2
  write_capacity = 2
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "idempotency_keys" {
  name           = "${var.project_name}-idempotency-keys"
  billing_mode   = "PROVISIONED"
  read_capacity  = 1
  write_capacity = 2
  hash_key       = "key"

  attribute {
    name = "key"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
