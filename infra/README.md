# Infrastructure

`cloudformation.yaml` provisions the application stack: an S3 + CloudFront static site, a Cognito
user pool (admin-invite-only) with a hosted-UI app client, a Regional REST API authorized by
Cognito, a Lambda progress function, a DynamoDB table, CloudWatch logs, and alarms.

This template is **not fully self-contained**. Satisfy these prerequisites first.

## Prerequisites (not created by the template)

1. **Lambda artifact bucket + zip.** Create an S3 bucket and upload the built Lambda package, then
   pass `CodeBucketName` and `CodeKey`. Build the zip with `python3 scripts/build_lambda.py`.

2. **IAM permissions boundary.** The Lambda execution role is created *under* a permissions-boundary
   policy that the template references by ARN (`PermissionsBoundaryArn`) but does **not** create.
   `boundary.example.json` is a sanitized starting point — replace `<region>`, `<account-id>`, and
   any resource names, create it as a customer-managed policy, and pass its ARN:

   ```sh
   aws iam create-policy \
     --policy-name english-flashcards-boundary \
     --policy-document file://infra/boundary.example.json
   # use the returned Arn as the PermissionsBoundaryArn parameter
   ```

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `SiteBucketName` | `english-flashcards-site` | Must be globally unique; adjust if taken. |
| `CodeBucketName` | `english-flashcards-artifacts` | Bucket holding the Lambda zip. |
| `CodeKey` | *(required)* | S3 key of the Lambda zip. |
| `CognitoDomainPrefix` | *(required)* | Globally-unique Cognito hosted-UI domain prefix. |
| `AlarmEmail` | *(required)* | Email subscribed to the alarm SNS topic. |
| `PermissionsBoundaryArn` | *(required)* | ARN of the pre-existing boundary policy (above). |

## Deploy (example)

```sh
aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name english-flashcards \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      CodeKey=lambda/progress.zip \
      CognitoDomainPrefix=english-flashcards-<your-account-id> \
      AlarmEmail=you@example.com \
      PermissionsBoundaryArn=arn:aws:iam::<account-id>:policy/english-flashcards-boundary
```

After the stack is created, generate `config.json` from the stack outputs (see the top-level
`README.md` "Configuration" section) and upload the built frontend to the site bucket.

## Not included in this public repo

The account-specific operational tooling used to deploy the author's own environment is intentionally
kept private: the concrete IAM permission sets and role-trust documents, the stack/import recovery
templates, billing/budget definitions, and any support-case notes. None of it is required to deploy
your own copy from the template above.
