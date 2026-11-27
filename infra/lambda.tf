# API Lambda (NestJS bundle), Function URL, execution role and log group.
# The real code is uploaded by deploy.yml (update-function-code); Terraform only
# creates the function from a placeholder zip and then ignores code changes.

locals {
  lambda_function_name = "${var.project_name}-api"

  dynamodb_tables = [
    aws_dynamodb_table.products,
    aws_dynamodb_table.customers,
    aws_dynamodb_table.transactions,
    aws_dynamodb_table.deliveries,
    aws_dynamodb_table.idempotency_keys,
  ]

  # Table ARNs plus their index ARNs (the only wildcard allowed is the index suffix).
  dynamodb_resource_arns = flatten([
    for table in local.dynamodb_tables : [table.arn, "${table.arn}/index/*"]
  ])

  lambda_ssm_parameter_arns = concat(
    [aws_ssm_parameter.origin_verify.arn],
    local.payment_secret_param_arns,
  )
}

# Placeholder code used only for the first creation of the function.
data "archive_file" "lambda_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.terraform/lambda-placeholder.zip"

  source {
    filename = "lambda.js"
    content  = <<-EOT
      exports.handler = async () => ({
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Placeholder code, deploy pending' }),
      });
    EOT
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.lambda_function_name}"
  retention_in_days = 7
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda_exec" {
  statement {
    sid       = "ReadParameters"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = local.lambda_ssm_parameter_arns
  }

  statement {
    sid    = "TablesAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:Query",
    ]
    resources = local.dynamodb_resource_arns
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project_name}-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  # Created by infra/bootstrap; the deploy role may only manage this role with it.
  permissions_boundary = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project_name}-lambda-boundary"
}

resource "aws_iam_role_policy" "lambda_exec" {
  name   = "${var.project_name}-lambda-exec"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_exec.json
}

resource "aws_lambda_function" "api" {
  function_name = local.lambda_function_name
  role          = aws_iam_role.lambda_exec.arn
  runtime       = "nodejs22.x"
  handler       = "lambda.handler"
  memory_size   = 512
  timeout       = 15

  filename         = coalesce(var.lambda_artifact_path, data.archive_file.lambda_placeholder.output_path)
  source_code_hash = var.lambda_artifact_path == null ? data.archive_file.lambda_placeholder.output_base64sha256 : filebase64sha256(var.lambda_artifact_path)

  # Values are parameter names and table names, never secrets.
  environment {
    variables = {
      PAYMENT_API_URL                 = var.payment_api_url
      PAYMENT_PUBLIC_KEY              = var.payment_public_key
      PAYMENT_PRIVATE_KEY_PARAM       = local.payment_private_key_param_name
      PAYMENT_INTEGRITY_SECRET_PARAM  = local.payment_integrity_secret_param_name
      PAYMENT_EVENTS_SECRET_PARAM     = local.payment_events_secret_param_name
      ORIGIN_VERIFY_SECRET_PARAM      = aws_ssm_parameter.origin_verify.name
      BASE_FEE_IN_CENTS               = "300000"
      DELIVERY_FEE_IN_CENTS           = "800000"
      DYNAMODB_TABLE_PRODUCTS         = aws_dynamodb_table.products.name
      DYNAMODB_TABLE_CUSTOMERS        = aws_dynamodb_table.customers.name
      DYNAMODB_TABLE_TRANSACTIONS     = aws_dynamodb_table.transactions.name
      DYNAMODB_TABLE_DELIVERIES       = aws_dynamodb_table.deliveries.name
      DYNAMODB_TABLE_IDEMPOTENCY_KEYS = aws_dynamodb_table.idempotency_keys.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_iam_role_policy.lambda_exec,
  ]

  # deploy.yml owns the code after the first creation.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# Auth NONE: access is restricted by the X-Origin-Verify check inside the app.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# Function URLs need both permissions or CloudFront receives 403.
resource "aws_lambda_permission" "function_url_invoke_url" {
  statement_id           = "AllowPublicInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "function_url_invoke_function" {
  statement_id             = "AllowPublicInvokeFunctionViaUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "*"
  invoked_via_function_url = true
}
