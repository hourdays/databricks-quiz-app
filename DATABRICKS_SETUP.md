# Databricks Setup Guide

## Environment Variables

Set the following environment variables to connect to your Databricks table:

```bash
# Your Databricks workspace hostname (e.g., adb-1234567890123456.7.azuredatabricks.net)
export DATABRICKS_SERVER_HOSTNAME=your-databricks-hostname

# Your SQL warehouse HTTP path (e.g., /sql/1.0/warehouses/1234567890abcdef)
export DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id

# Your Databricks personal access token
export DATABRICKS_ACCESS_TOKEN=your-access-token

# Database configuration
export DATABRICKS_CATALOG=your-catalog
export DATABRICKS_SCHEMA=your-schema
export DATABRICKS_TABLE=your-table

# Server port (optional, defaults to 3000)
export PORT=3000
```

## Table Schema

Your Databricks table should have the following columns:

```sql
CREATE TABLE employees (
  email STRING,
  start_month_year STRING
);
```

Example data:
```sql
INSERT INTO employees VALUES 
  ('hugues.journeau@databricks.com', 'janvier 2020'),
  ('marc.bonnet@databricks.com', 'juin 2025'),
  ('john.doe@databricks.com', 'mars 2021');
```

## Getting Your Databricks Credentials

1. **Server Hostname**: Go to your Databricks workspace URL and copy the hostname
2. **HTTP Path**: Go to SQL Warehouses → Your warehouse → Connection details
3. **Access Token**: Go to User Settings → Developer → Access tokens → Generate new token

## Testing the Connection

The app will automatically fall back to the mock database if Databricks is not configured, so you can test the app immediately. To use real Databricks data, set up the environment variables above.
