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
# Seed_Items: the catalog comes from Terraform, so the first apply leaves the
# products table ready for GET /products. The stock values are only the initial
# values. ignore_changes keeps a stock decrement committed by Finalization from
# being reverted by a later apply.
resource "aws_dynamodb_table_item" "product_1" {
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key
  item = jsonencode({
    id           = { S = "01JDK3M7N2P5Q8R1S4T6V9W0XA" }
    sku          = { S = "SKU-001" }
    name         = { S = "Audífonos inalámbricos" }
    description  = { S = "Audífonos Bluetooth con cancelación de ruido y 30 horas de batería." }
    imageUrl     = { S = "/images/sku-001.webp" }
    priceInCents = { N = "12000000" }
    currency     = { S = "COP" }
    stock        = { N = "0" }
  })
  lifecycle {
    ignore_changes = [item]
  }
}
resource "aws_dynamodb_table_item" "product_2" {
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key
  item = jsonencode({
    id           = { S = "01JDK3M7N2P5Q8R1S4T6V9W0XB" }
    sku          = { S = "SKU-002" }
    name         = { S = "Teclado mecánico compacto" }
    description  = { S = "Teclado mecánico de 75 teclas con interruptores táctiles y conexión USB-C." }
    imageUrl     = { S = "/images/sku-002.webp" }
    priceInCents = { N = "8500000" }
    currency     = { S = "COP" }
    stock        = { N = "1" }
  })
  lifecycle {
    ignore_changes = [item]
  }
}
resource "aws_dynamodb_table_item" "product_3" {
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key
  item = jsonencode({
    id           = { S = "01JDK3M7N2P5Q8R1S4T6V9W0XC" }
    sku          = { S = "SKU-003" }
    name         = { S = "Mochila urbana de 20 litros" }
    description  = { S = "Mochila impermeable con compartimento acolchado para portátil de 15 pulgadas." }
    imageUrl     = { S = "/images/sku-003.webp" }
    priceInCents = { N = "15000000" }
    currency     = { S = "COP" }
    stock        = { N = "5" }
  })
  lifecycle {
    ignore_changes = [item]
  }
}
resource "aws_dynamodb_table_item" "product_4" {
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key
  item = jsonencode({
    id           = { S = "01JDK3M7N2P5Q8R1S4T6V9W0XD" }
    sku          = { S = "SKU-004" }
    name         = { S = "Termo de acero de 750 ml" }
    description  = { S = "Termo de acero inoxidable que mantiene la temperatura durante 12 horas." }
    imageUrl     = { S = "/images/sku-004.webp" }
    priceInCents = { N = "4500000" }
    currency     = { S = "COP" }
    stock        = { N = "10" }
  })
  lifecycle {
    ignore_changes = [item]
  }
}
