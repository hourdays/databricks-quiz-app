# Databricks Setup Guide

This guide covers the complete setup for the Databricks Quiz App, including the main quiz functionality and the admin chatbot feature.

## Dependencies

The app requires the following Node.js dependencies (install with `npm install`):
- `express` - Web server
- `socket.io` - Real-time communication
- `@databricks/sql` - Databricks SQL connectivity
- `axios` - HTTP client for Genie API
- `uuid` - Unique identifier generation

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

# Your Databricks results table name (e.g., game_scores)
export DATABRICKS_RESULTS_TABLE=your-results-table

# Databricks Genie configuration for chatbot functionality
export DATABRICKS_WORKSPACE_URL=https://your-workspace.cloud.databricks.com
export DATABRICKS_GENIE_SPACE_ID=your-genie-space-id

# Server port (optional, defaults to 3000)
export PORT=3000
```

## Table Schemas

### Employee Table

Your Databricks employee table should have the following columns:

```sql
CREATE TABLE employees (
  email STRING,
  databricks_arrival_month_year STRING
);
```

Example data:
```sql
INSERT INTO employees VALUES 
  ('hugues.journeau@databricks.com', 'janvier 2020'),
  ('marc.bonnet@databricks.com', 'juin 2025'),
  ('john.doe@databricks.com', 'mars 2021');
```

### Results Table

The quiz results will be automatically saved to a results table with the following schema:

```sql
CREATE TABLE game_scores (
  game_id STRING,
  player_email STRING,
  player_answer STRING,
  answer_time DOUBLE,
  score DOUBLE,
  rank INT,
  is_correct BOOLEAN,
  game_timestamp TIMESTAMP,
  created_at TIMESTAMP
) USING DELTA;
```

The results table will be created automatically if it doesn't exist. All quiz games will use the game ID "espresso" and all player responses will be logged with their scores, ranks, and timing information.

## Getting Your Databricks Credentials

1. **Server Hostname**: Go to your Databricks workspace URL and copy the hostname
2. **HTTP Path**: Go to SQL Warehouses → Your warehouse → Connection details
3. **Access Token**: Go to User Settings → Developer → Access tokens → Generate new token
4. **Workspace URL**: Your full Databricks workspace URL (e.g., https://your-workspace.cloud.databricks.com)
5. **Genie Space ID**: The ID of your Databricks Genie space for chatbot functionality

## Chatbot Functionality (Admin Feature)

The admin leaderboard includes a Databricks Genie chatbot that allows administrators to ask natural language questions about their data.

### Prerequisites for Chatbot
- Same prerequisites as the main Databricks integration
- A configured Genie space with the provided space ID
- `CAN RUN` privileges on the Genie space

### Chatbot Configuration
The chatbot uses the same access token and workspace as the main application - no additional authentication is required. The additional environment variables are:
- `DATABRICKS_WORKSPACE_URL`: Your full workspace URL (e.g., https://adb-984752964297111.11.azuredatabricks.net)
- `DATABRICKS_GENIE_SPACE_ID`: Your Genie space ID (already set in start-local.sh)

The chatbot will automatically use the server-side PAT (Personal Access Token) configured in your environment variables.

### Using the Chatbot
1. Access the admin leaderboard as an administrator
2. Click "🤖 Talk to the Scores" button
3. This will take you to a dedicated chat page
4. Click "Start Chat" to connect to Databricks Genie
5. Ask natural language questions about your data
6. The chatbot will provide real-time responses from Databricks Genie

### Chatbot Troubleshooting
- **"Failed to connect to Databricks Genie"**: Check your `DATABRICKS_WORKSPACE_URL` and `DATABRICKS_ACCESS_TOKEN`
- **"Only admin can access the chatbot"**: Make sure you're accessing the admin leaderboard page
- **"No response received from Genie"**: Check your Genie space configuration in Databricks

## Testing the Connection

The app will automatically fall back to the mock database if Databricks is not configured, so you can test the app immediately. To use real Databricks data, set up the environment variables above.

### Quick Start
For local development, use the provided script:
```bash
./start-local.sh
```

This script sets up all environment variables including the chatbot configuration and starts the application.

### Testing the Chatbot
The chatbot will show an error message if the Genie configuration is not properly set up, but the main quiz functionality will continue to work normally. Once properly configured, you can test the chatbot by:
1. Running the app with `./start-local.sh`
2. Accessing the admin leaderboard
3. Clicking "🤖 Talk to the Scores" button
4. Clicking "Start Chat" on the chat page
5. Asking a question like "How many employees do we have?"

**Direct Access**: You can also go directly to `http://localhost:3000/chat` to access the chatbot without going through the admin leaderboard.
