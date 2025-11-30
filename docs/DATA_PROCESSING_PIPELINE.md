# Daily Data Processing Pipeline

## Overview

This document describes the automated daily data processing pipeline implemented as a GitHub Actions workflow. The pipeline processes CSV files from `/data/input/` and outputs processed results to `/data/output/` on a daily schedule.

## Workflow Configuration

### File Location
`.github/workflows/daily-data-processing.yml`

### Schedule
- **Frequency**: Daily
- **Time**: 10:36 AM EST (15:36 UTC)
- **Trigger**: Cron schedule `36 15 * * *`
- **Manual Trigger**: Available via workflow_dispatch

### Key Features

1. **Scheduled Execution**: Runs automatically every day at 10:36 AM EST
2. **Email Notifications**: 
   - Sent to `scarmonit@gmail.com` on pipeline start
   - Sent to `scarmonit@gmail.com` on pipeline failure
   - Sent for skipped/cancelled runs (alerts enabled)
3. **Concurrency Control**: Maximum 1 concurrent run (enforced via concurrency group)
4. **Retry Logic**: 
   - Up to 3 retry attempts on failure
   - 5 minutes (300 seconds) wait between retry attempts
   - Retry on error conditions
5. **Tags**: 
   - Environment: Production
   - Type: Automated

## Architecture

### Workflow Components

```yaml
name: Daily Data Processing Pipeline

Jobs:
  - data-processing:
      - Checkout repository
      - Send start notification email
      - Setup Python environment
      - Install Databricks CLI
      - Configure Databricks CLI
      - Execute Data Processing Notebook (with retries)
      - Send failure notification email (if failed)
      - Send skipped/cancelled notification email (if cancelled)
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Scheduler (Daily at 10:36 AM EST)                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Send Start Notification → scarmonit@gmail.com          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Setup Environment (Python + Databricks CLI)            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Execute Databricks Notebook                             │
│     Path: /Workspace/Users/scarmonit@gmail.com/             │
│           Sample_Data_Processing_Notebook                   │
│                                                             │
│     Parameters:                                             │
│     - input_path: /data/input/sample_data.csv              │
│     - output_path: /data/output/processed_data.csv         │
│                                                             │
│     Retry: Up to 3 attempts, 5 min between attempts        │
└────────────────────────┬────────────────────────────────────┘
                         │
                    ┌────┴────┐
                    │         │
              Success?    Failure?
                    │         │
                    │         ▼
                    │    ┌────────────────────────────────────┐
                    │    │ Send Failure Notification          │
                    │    │ → scarmonit@gmail.com              │
                    │    └────────────────────────────────────┘
                    │
                    ▼
              ┌──────────┐
              │  Success │
              └──────────┘
```

## Setup Instructions

### Prerequisites

1. **Databricks Workspace**: A configured Databricks workspace with the notebook at the specified path
2. **Email Service**: SMTP credentials for sending notification emails
3. **GitHub Repository**: Access to configure GitHub secrets

### Required GitHub Secrets

You must configure the following secrets in your GitHub repository:

#### 1. DATABRICKS_TOKEN

**Description**: Authentication token for Databricks workspace

**How to obtain**:
1. Log in to your Databricks workspace
2. Navigate to User Settings → Access Tokens
3. Click "Generate New Token"
4. Copy the token (it will only be shown once)

**How to add to GitHub**:
```bash
# Navigate to: Repository → Settings → Secrets and variables → Actions
# Click "New repository secret"
# Name: DATABRICKS_TOKEN
# Value: <your-databricks-token>
```

#### 2. EMAIL_USERNAME

**Description**: SMTP username for sending email notifications

**For Gmail**:
- Use your Gmail address (e.g., `your-email@gmail.com`)
- If using Gmail, you'll need to use an App Password (not your regular password)

**How to create Gmail App Password**:
1. Enable 2-Factor Authentication on your Google account
2. Go to Google Account → Security → 2-Step Verification → App passwords
3. Generate an app password for "Mail"
4. Use this app password for EMAIL_PASSWORD secret

**How to add to GitHub**:
```bash
# Repository → Settings → Secrets and variables → Actions
# Click "New repository secret"
# Name: EMAIL_USERNAME
# Value: your-email@gmail.com
```

#### 3. EMAIL_PASSWORD

**Description**: SMTP password for sending email notifications

**For Gmail**: Use the App Password generated in the previous step

**How to add to GitHub**:
```bash
# Repository → Settings → Secrets and variables → Actions
# Click "New repository secret"
# Name: EMAIL_PASSWORD
# Value: <your-app-password>
```

### Databricks Workspace Configuration

#### Update Workspace URL

Edit `.github/workflows/daily-data-processing.yml` and update the `WORKSPACE_URL` environment variable:

```yaml
env:
  WORKSPACE_URL: 'https://your-actual-workspace.cloud.databricks.com'
```

Replace `your-actual-workspace` with your actual Databricks workspace hostname.

#### Notebook Requirements

The Databricks notebook at `/Workspace/Users/scarmonit@gmail.com/Sample_Data_Processing_Notebook` should:

1. Accept the following parameters:
   - `input_path`: Path to input CSV file
   - `output_path`: Path to output processed CSV file

2. Implement data processing logic that:
   - Reads CSV from `input_path`
   - Processes the data
   - Writes results to `output_path`

#### Example Notebook Structure

```python
# Databricks notebook source

# COMMAND ----------
# Get parameters
dbutils.widgets.text("input_path", "/data/input/sample_data.csv")
dbutils.widgets.text("output_path", "/data/output/processed_data.csv")

input_path = dbutils.widgets.get("input_path")
output_path = dbutils.widgets.get("output_path")

# COMMAND ----------
# Read input data
df = spark.read.csv(input_path, header=True, inferSchema=True)

# COMMAND ----------
# Process data (example: filter, transform, aggregate)
processed_df = df.filter(df['column'] > 0)  # Add your processing logic

# COMMAND ----------
# Write output
processed_df.write.csv(output_path, header=True, mode="overwrite")

# COMMAND ----------
print(f"Processing complete: {input_path} → {output_path}")
```

## Monitoring and Maintenance

### Email Notifications

You will receive email notifications for:

1. **Pipeline Start**: Sent when the workflow begins execution
2. **Pipeline Failure**: Sent if any step fails after all retries
3. **Pipeline Cancelled**: Sent if the workflow is manually cancelled or skipped

### Viewing Workflow Runs

1. Navigate to the repository on GitHub
2. Click on the "Actions" tab
3. Select "Daily Data Processing Pipeline" from the left sidebar
4. View all workflow runs, their status, and logs

### Manual Trigger

To manually trigger the workflow:

1. Go to Actions → Daily Data Processing Pipeline
2. Click "Run workflow" button
3. Select the branch (patch-1 or main)
4. Click "Run workflow"

### Troubleshooting

#### Workflow Not Running

**Problem**: Workflow doesn't execute at scheduled time

**Solutions**:
- Ensure the workflow file is merged to the main branch
- Check that the cron syntax is correct: `36 15 * * *`
- GitHub Actions may delay scheduled workflows by up to 15 minutes during high load

#### Email Notifications Not Received

**Problem**: Not receiving email notifications

**Solutions**:
- Verify EMAIL_USERNAME and EMAIL_PASSWORD secrets are set correctly
- Check spam/junk folder
- For Gmail, ensure App Password is used (not regular password)
- Verify 2FA is enabled on the Gmail account

#### Databricks Connection Fails

**Problem**: Workflow fails when connecting to Databricks

**Solutions**:
- Verify DATABRICKS_TOKEN secret is valid and not expired
- Check WORKSPACE_URL is correct in the workflow file
- Ensure the token has appropriate permissions
- Generate a new token if the current one has expired

#### Notebook Execution Fails

**Problem**: Notebook execution step fails

**Solutions**:
- Verify notebook exists at the specified path
- Check notebook accepts the required parameters (input_path, output_path)
- Review notebook logs in Databricks workspace
- Ensure input data exists at `/data/input/sample_data.csv`
- Verify permissions to read/write to data paths

## Customization

### Changing Schedule Time

To change the execution time, edit the cron expression in `.github/workflows/daily-data-processing.yml`:

```yaml
on:
  schedule:
    - cron: '36 15 * * *'  # Change to your desired time (UTC)
```

**Note**: Times are in UTC. Calculate your local time offset:
- EST is UTC-5 (winter) or UTC-4 (summer)
- For 10:36 AM EST winter, use 15:36 UTC
- For 10:36 AM EDT summer, use 14:36 UTC

### Changing Input/Output Paths

Update the environment variables in the workflow file:

```yaml
env:
  INPUT_PATH: '/data/input/your_custom_input.csv'
  OUTPUT_PATH: '/data/output/your_custom_output.csv'
```

### Adding Additional Notifications

To add more notification recipients, modify the `to:` field in the email action steps:

```yaml
- name: Send start notification email
  uses: dawidd6/action-send-mail@v3
  with:
    to: scarmonit@gmail.com, another-email@example.com, third@example.com
```

### Adjusting Retry Settings

To change retry behavior, modify the retry action parameters:

```yaml
- name: Execute Data Processing Notebook (with retries)
  uses: nick-fields/retry@v3
  with:
    max_attempts: 5              # Change number of attempts
    retry_wait_seconds: 600      # Change wait time (in seconds)
```

## Performance Optimization

The workflow is configured with `performance_target: PERFORMANCE_OPTIMIZED` to ensure optimal execution:

1. **Concurrent Runs**: Limited to 1 to prevent resource conflicts
2. **Timeout**: No timeout (0) to allow long-running processing jobs
3. **Retry Strategy**: 3 attempts with 5-minute intervals to handle transient failures

## Compliance and Security

### Data Security

- All credentials stored as encrypted GitHub secrets
- Databricks token used for secure authentication
- Email credentials never exposed in logs

### Tags and Classification

```yaml
env:
  ENVIRONMENT: Production
  TYPE: Automated
```

These tags help with:
- Resource tracking
- Cost allocation
- Environment identification
- Compliance reporting

## Support

For issues or questions:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review workflow run logs in GitHub Actions
3. Review notebook execution logs in Databricks
4. Contact: scarmonit@gmail.com

## Version History

- **v1.0** (2025-11-04): Initial implementation
  - Daily scheduling at 10:36 AM EST
  - Email notifications for start/failure/cancelled events
  - Databricks integration
  - Retry logic with 3 attempts
  - Production tags

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Databricks CLI Documentation](https://docs.databricks.com/dev-tools/cli/index.html)
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions)
- [Databricks Jobs API](https://docs.databricks.com/dev-tools/api/latest/jobs.html)
