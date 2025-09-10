const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DBSQLClient } = require('@databricks/sql');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// Performance optimizations for 100+ players
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Optimize for high concurrency
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// Databricks configuration
const databricksConfig = {
  serverHostname: process.env.DATABRICKS_WORKSPACE_URL?.replace('https://', '') || 'your-workspace-url',
  httpPath: `/sql/1.0/warehouses/${process.env.DATABRICKS_WAREHOUSE_ID || 'your-warehouse-id'}`,
  accessToken: process.env.DATABRICKS_ACCESS_TOKEN || 'your-access-token',
  catalog: process.env.DATABRICKS_CATALOG || 'your-catalog',
  schema: process.env.DATABRICKS_SCHEMA || 'quiz',
  table: process.env.DATABRICKS_TABLE || 'users',
  // New table for storing quiz results
  resultsTable: process.env.DATABRICKS_RESULTS_TABLE || 'game_scores'
};

// Genie configuration
const genieConfig = {
  workspaceUrl: process.env.DATABRICKS_WORKSPACE_URL || 'https://your-workspace-url',
  accessToken: process.env.DATABRICKS_ACCESS_TOKEN || 'your-access-token',
  spaceId: process.env.DATABRICKS_GENIE_SPACE_ID || 'your-genie-space-id'
};

// Log configuration for debugging
console.log('🔧 App Configuration:');
console.log('   DATABRICKS_WORKSPACE_URL:', process.env.DATABRICKS_WORKSPACE_URL || 'NOT SET');
console.log('   DATABRICKS_ACCESS_TOKEN:', process.env.DATABRICKS_ACCESS_TOKEN ? 'SET' : 'NOT SET');
console.log('   DATABRICKS_GENIE_SPACE_ID:', process.env.DATABRICKS_GENIE_SPACE_ID || 'NOT SET');
console.log('   DATABRICKS_WAREHOUSE_ID:', process.env.DATABRICKS_WAREHOUSE_ID || 'NOT SET');
console.log('   DATABRICKS_CATALOG:', process.env.DATABRICKS_CATALOG || 'NOT SET');
console.log('   DATABRICKS_SCHEMA:', process.env.DATABRICKS_SCHEMA || 'NOT SET');

// Log Genie configuration (without exposing full token)
console.log('🔧 Genie Configuration:');
console.log(`   Workspace URL: ${genieConfig.workspaceUrl}`);
console.log(`   Space ID: ${genieConfig.spaceId}`);
console.log(`   Access Token Length: ${genieConfig.accessToken ? genieConfig.accessToken.length : 'NOT SET'}`);
console.log(`   Access Token Preview: ${genieConfig.accessToken ? genieConfig.accessToken.substring(0, 20) + '...' : 'NOT SET'}`);

// Databricks client
const databricksClient = new DBSQLClient();

// Test database connection on startup
async function testDatabaseConnection() {
  try {
    console.log('🔍 Testing database connection...');
    await databricksClient.connect({
      serverHostname: databricksConfig.serverHostname,
      httpPath: databricksConfig.httpPath,
      token: databricksConfig.accessToken
    });
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Mock employee database for fallback/development
const mockEmployeeDatabase = {
  'hugues.journeau@databricks.com': 'janvier 2020',
  'hjourneau@gmail.com': 'mars 2021',
  'marc.bonnet@databricks.com': 'juin 2025',
  'paul.r@dbks.fr': 'septembre 2023',
  // Add more employees as needed
};

// Store active tokens and game state
const activeTokens = new Set();
const gameState = {
  isStarted: false,
  currentPhase: 'waiting', // waiting, photos, question, leaderboard
  currentQuestion: 0,
  totalQuestions: 1,
  photoTimeLeft: 10,
  questionTimeLeft: 10,
  players: new Map(),
  leaderboard: [],
  // Server-side timing for precise ranking
  questionStartTime: null,
  questionEndTime: null
};

// Global timer variables
let photoTimer = null;
let questionTimer = null;

// Function to validate employee start month/year against Databricks table
async function validateEmployeeStartMonthYear(email, monthYear) {
  console.log(`Validating employee: ${email} with start month/year: ${monthYear}`);
  
  try {
    // Connect to Databricks
    const connection = await databricksClient.connect({
      host: databricksConfig.serverHostname,
      path: databricksConfig.httpPath,
      token: databricksConfig.accessToken
    });

    // Create a session
    const session = await connection.openSession();

    // Query to check if employee exists with matching month/year
    const query = `
      SELECT COUNT(*) as count 
      FROM ${databricksConfig.catalog}.${databricksConfig.schema}.${databricksConfig.table}
      WHERE LOWER(email) = LOWER('${email}') AND LOWER(databricks_arrival_month_year) = LOWER('${monthYear}')
    `;
    
    const queryResult = await session.executeStatement(query);

    const results = await queryResult.fetchAll();
    const count = results[0].count;
    
    await queryResult.close();
    await session.close();
    await connection.close();
    
    if (count > 0) {
      console.log(`Validation successful for ${email}`);
      return true;
    } else {
      console.log(`Employee ${email} with month/year ${monthYear} not found in Databricks table`);
      return false;
    }
    
  } catch (error) {
    console.error('Databricks validation error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState
    });
    
    // Fallback to mock database if Databricks is not configured
    if (error.message.includes('your-databricks-hostname') || 
        error.message.includes('your-access-token') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('ECONNREFUSED')) {
      console.log('Databricks not configured, falling back to mock database');
      return validateWithMockDatabase(email, monthYear);
    }
    
    return false;
  }
}

// Fallback function using mock database
function validateWithMockDatabase(email, monthYear) {
  console.log(`Using mock database for validation: ${email} with ${monthYear}`);
  
  // Check if employee exists in our mock database
  if (!mockEmployeeDatabase[email]) {
    console.log(`Employee ${email} not found in mock database`);
    return false;
  }
  
  // Check if the provided month/year matches the recorded month/year
  const recordedMonthYear = mockEmployeeDatabase[email];
  if (monthYear.toLowerCase() !== recordedMonthYear.toLowerCase()) {
    console.log(`Month/year mismatch for ${email}: provided ${monthYear}, expected ${recordedMonthYear}`);
    return false;
  }
  
  console.log(`Mock validation successful for ${email}`);
  return true;
}

// Genie API functions
async function sendGenieMessage(message) {
  try {
    const response = await axios.post(
      `${genieConfig.workspaceUrl}/api/2.0/genie/spaces/${genieConfig.spaceId}/start-conversation`,
      {
        content: message
      },
      {
        headers: {
          'Authorization': `Bearer ${genieConfig.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Genie response received:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending Genie message:', error.response?.data || error.message);
    throw error;
  }
}

async function getGenieMessageStatus(spaceId, conversationId, messageId) {
  try {
    console.log(`🔍 Polling Genie message status...`);
    console.log(`   Space ID: ${spaceId}`);
    console.log(`   Conversation ID: ${conversationId}`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Workspace URL: ${genieConfig.workspaceUrl}`);
    console.log(`   Access Token (first 20 chars): ${genieConfig.accessToken.substring(0, 20)}...`);
    
    const url = `${genieConfig.workspaceUrl}/api/2.0/genie/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}`;
    console.log(`   Full URL: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${genieConfig.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Genie message status response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('❌ Error getting Genie message status:');
    console.error('   Status:', error.response?.status);
    console.error('   Status Text:', error.response?.statusText);
    console.error('   Headers:', error.response?.headers);
    console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('   Full Error:', error.message);
    throw error;
  }
}

async function testGeniePermissions(spaceId) {
  try {
    console.log(`🔐 Testing Genie permissions for space: ${spaceId}`);
    
    // Test 1: Try to get space info
    const spaceUrl = `${genieConfig.workspaceUrl}/api/2.0/genie/spaces/${spaceId}`;
    console.log(`   Testing space info endpoint: ${spaceUrl}`);
    
    const spaceResponse = await axios.get(spaceUrl, {
      headers: {
        'Authorization': `Bearer ${genieConfig.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Space info accessible:', JSON.stringify(spaceResponse.data, null, 2));
    
    // Test 2: Try to list conversations in the space
    const conversationsUrl = `${genieConfig.workspaceUrl}/api/2.0/genie/spaces/${spaceId}/conversations`;
    console.log(`   Testing conversations list endpoint: ${conversationsUrl}`);
    
    const conversationsResponse = await axios.get(conversationsUrl, {
      headers: {
        'Authorization': `Bearer ${genieConfig.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Conversations list accessible:', JSON.stringify(conversationsResponse.data, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Permission test failed:');
    console.error('   Status:', error.response?.status);
    console.error('   Status Text:', error.response?.statusText);
    console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
    
    // Check if it's specifically a permission issue
    if (error.response?.data?.error_code === 'PERMISSION_DENIED') {
      console.error('🚨 PERMISSION_DENIED detected!');
      console.error('   This suggests the access token does not have the required permissions.');
      console.error('   Please verify:');
      console.error('   1. The access token is valid and not expired');
      console.error('   2. The token has "Can View" permission on the Genie space');
      console.error('   3. The space ID is correct');
      console.error('   4. The workspace URL is correct');
    }
    
    return false;
  }
}

async function getQueryResults(statementId) {
  try {
    console.log(`📊 Fetching query results for statement: ${statementId}`);
    
    const resultsUrl = `${genieConfig.workspaceUrl}/api/2.0/sql/statements/${statementId}`;
    console.log(`   Results URL: ${resultsUrl}`);
    
    const response = await axios.get(resultsUrl, {
      headers: {
        'Authorization': `Bearer ${genieConfig.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Query results fetched:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('❌ Failed to fetch query results:');
    console.error('   Status:', error.response?.status);
    console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
    return null;
  }
}

async function waitForGenieResponse(spaceId, conversationId, messageId, maxAttempts = 20, delayMs = 3000) {
  // First test permissions
  const hasPermissions = await testGeniePermissions(spaceId);
  if (!hasPermissions) {
    return `❌ **Permission Test Failed**: Cannot access Genie space. Please verify your access token has the correct permissions.`;
  }
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const messageStatus = await getGenieMessageStatus(spaceId, conversationId, messageId);
      
      console.log(`Attempt ${attempt + 1}: Status = ${messageStatus.status}`);
      
      if (messageStatus.status === 'COMPLETED') {
        // Try to get the actual data from query results
        if (messageStatus.query_result && messageStatus.query_result.statement_id) {
          const statementId = messageStatus.query_result.statement_id;
          const queryResults = await getQueryResults(statementId);
          
          if (queryResults && queryResults.result && queryResults.result.data_array) {
            const data = queryResults.result.data_array;
            if (data.length > 0) {
              // Just return the actual data values
              const values = data.map(row => row.join(', ')).join('\n');
              return values;
            }
          }
        }
        
        // Fallback: try to get any text response from attachments
        if (messageStatus.attachments && messageStatus.attachments.length > 0) {
          const attachment = messageStatus.attachments[0];
          if (attachment.text) {
            return attachment.text;
          }
        }
        
        // Final fallback
        return 'No data found in response.';
      } else if (messageStatus.status === 'FAILED') {
        return `❌ Genie processing failed. Error: ${messageStatus.error || 'Unknown error'}`;
      } else if (messageStatus.status === 'CANCELLED') {
        return '❌ Genie processing was cancelled.';
      }
      
      // Wait before next attempt
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error.message);
      
      // If it's a permission error, provide helpful guidance
      if (error.response?.status === 403) {
        return `❌ **Permission Error**: Unable to poll for Genie response.

🔧 **Required Permissions:**
Your access token needs "Can View" permission on the Genie space to poll for responses.

📋 **Conversation Details:**
• Conversation ID: ${conversationId}
• Message ID: ${messageId}
• Space ID: ${spaceId}

💡 **To see the AI response:**
1. Go to your Databricks workspace
2. Navigate to the Genie space: ${spaceId}
3. Look for conversation: ${conversationId}
4. The AI response should appear there shortly

⏱️ **Processing time:** Usually 30 seconds to 2 minutes for most queries.`;
      }
      
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  return '⏰ Response timeout - Genie is still processing your request. This can take up to 10 minutes for complex queries.';
}

// Function to save quiz results to Databricks
async function saveQuizResults(gameId, results) {
  console.log(`Saving quiz results for game ${gameId}:`, results);
  
  try {
    // Connect to Databricks
    const connection = await databricksClient.connect({
      host: databricksConfig.serverHostname,
      path: databricksConfig.httpPath,
      token: databricksConfig.accessToken
    });

    const session = await connection.openSession();

    // Create the results table if it doesn't exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${databricksConfig.catalog}.${databricksConfig.schema}.${databricksConfig.resultsTable} (
        game_id STRING,
        player_email STRING,
        player_answer STRING,
        answer_time DOUBLE,
        score DOUBLE,
        rank INT,
        is_correct BOOLEAN,
        game_timestamp TIMESTAMP,
        created_at TIMESTAMP
      ) USING DELTA
    `;
    
    await session.executeStatement(createTableQuery);
    console.log('Results table created/verified successfully');

    // Insert each result
    for (const result of results) {
      const insertQuery = `
        INSERT INTO ${databricksConfig.catalog}.${databricksConfig.schema}.${databricksConfig.resultsTable} 
        (game_id, player_email, player_answer, answer_time, score, rank, is_correct, game_timestamp, created_at)
        VALUES (
          '${gameId}',
          '${result.email}',
          '${result.answer}',
          ${result.answerTime || 0},
          ${result.score || 0},
          ${result.rank || 0},
          ${result.isCorrect || false},
          '${new Date().toISOString()}',
          '${new Date().toISOString()}'
        )
      `;
      
      await session.executeStatement(insertQuery);
      console.log(`Saved result for ${result.email}: ${result.answer} (${result.answerTime}s, score: ${result.score})`);
    }

    await session.close();
    await connection.close();
    
    console.log(`Successfully saved ${results.length} quiz results to Databricks`);
    return true;
    
  } catch (error) {
    console.error('Error saving quiz results to Databricks:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState
    });
    
    // Don't fail the game if logging fails
    console.log('Continuing game despite logging error');
    return false;
  }
}

// Function to clear game_scores table
async function clearGameScores() {
  console.log('Clearing game_scores table...');
  
  try {
    // Connect to Databricks
    const connection = await databricksClient.connect({
      host: databricksConfig.serverHostname,
      path: databricksConfig.httpPath,
      token: databricksConfig.accessToken
    });

    const session = await connection.openSession();

    // Clear the game_scores table
    const clearTableQuery = `
      DELETE FROM ${databricksConfig.catalog}.${databricksConfig.schema}.${databricksConfig.resultsTable}
      WHERE game_id = 'espresso'
    `;
    
    await session.executeStatement(clearTableQuery);
    console.log('Successfully cleared game_scores table');

    await session.close();
    await connection.close();
    
    return true;
    
  } catch (error) {
    console.error('Error clearing game_scores table:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState
    });
    
    // Don't fail the reset if clearing fails
    console.log('Continuing reset despite clearing error');
    return false;
  }
}

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Health check endpoint for Databricks app deployment
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '3.0.0-gold',
    services: {
      databricks: 'connected',
      genie: 'configured',
      socketio: 'active'
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/waiting', (req, res) => {
  res.sendFile(path.join(__dirname, 'waiting.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'game.html'));
});

app.get('/question', (req, res) => {
  res.sendFile(path.join(__dirname, 'question.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// Step 1: Validate email and generate temporary token
app.post('/api/validate-email', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  try {
    // Check if employee exists in Databricks table
    const connection = await databricksClient.connect({
      host: databricksConfig.serverHostname,
      path: databricksConfig.httpPath,
      token: databricksConfig.accessToken
    });

    const session = await connection.openSession();

    const query = `
      SELECT COUNT(*) as count 
      FROM ${databricksConfig.catalog}.${databricksConfig.schema}.${databricksConfig.table}
      WHERE LOWER(email) = LOWER('${email}')
    `;
    
    const queryResult = await session.executeStatement(query);

    const results = await queryResult.fetchAll();
    const count = results[0].count;
    
    await queryResult.close();
    await session.close();
    await connection.close();
    
    if (count === 0) {
      // Fallback to mock database if not found in Databricks
      if (!mockEmployeeDatabase[email]) {
        return res.status(403).json({ 
          error: 'Email not found in our records. Please contact support.' 
        });
      }
    }
    
    // Generate temporary token for step 2
    const tempToken = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store temporary data
    if (!global.tempUserStore) {
      global.tempUserStore = new Map();
    }
    global.tempUserStore.set(tempToken, { email });
    
    res.json({ tempToken, message: 'Email validated. Please proceed to step 2.' });
    
  } catch (error) {
    console.error('Email validation error:', error);
    
    // Fallback to mock database if Databricks is not configured
    if (error.message.includes('your-databricks-hostname') || 
        error.message.includes('your-access-token') ||
        error.message.includes('ENOTFOUND')) {
      console.log('Databricks not configured, using mock database for email validation');
      
      if (!mockEmployeeDatabase[email]) {
        return res.status(403).json({ 
          error: 'Email not found in our records. Please contact support.' 
        });
      }
      
      // Generate temporary token for step 2
      const tempToken = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store temporary data
      if (!global.tempUserStore) {
        global.tempUserStore = new Map();
      }
      global.tempUserStore.set(tempToken, { email });
      
      res.json({ tempToken, message: 'Email validated. Please proceed to step 2.' });
    } else {
      res.status(500).json({ error: 'Internal server error during email validation' });
    }
  }
});

// Step 2: Validate month/year and generate final token
app.post('/api/token', async (req, res) => {
  const { tempToken, monthYear } = req.body;
  if (!tempToken || !monthYear) {
    return res.status(400).json({ error: 'Temporary token and month/year are required' });
  }
  
  // Get email from temporary store
  if (!global.tempUserStore || !global.tempUserStore.has(tempToken)) {
    return res.status(400).json({ error: 'Invalid or expired temporary token' });
  }
  
  const { email } = global.tempUserStore.get(tempToken);
  
  try {
    // Validate employee start month/year against database
    const isValidEmployee = await validateEmployeeStartMonthYear(email, monthYear);
    
    if (!isValidEmployee) {
      return res.status(403).json({ 
        error: 'Invalid month/year. Please check your start month and year.' 
      });
    }
    
    // Generate final 6-digit token
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    activeTokens.add(token);
    
    // Store user data with token for later use
    const userData = {
      email,
      monthYear,
      token
    };
    
    // Store in a simple in-memory store (in production, use a database)
    if (!global.userDataStore) {
      global.userDataStore = new Map();
    }
    global.userDataStore.set(token, userData);
    
    // Clean up temporary token
    global.tempUserStore.delete(tempToken);
    
    res.json({ token });
    
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Internal server error during validation' });
  }
});

// Verify token
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (activeTokens.has(token)) {
    res.json({ valid: true });
  } else {
    res.status(401).json({ valid: false });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-waiting', (data) => {
    const { token, playerName } = data;
    if (activeTokens.has(token)) {
      const isAdmin = playerName === 'hugues.journeau@databricks.com';
      
      if (isAdmin) {
        // Admin joins admin room and doesn't become a player
        socket.join('admin');
        socket.emit('admin-joined', { message: 'Admin connected' });
        console.log(`Admin ${playerName} joined with socket ${socket.id}`);
      } else {
        // Store player by email instead of socket ID
        const playerKey = playerName || 'Anonymous';
        gameState.players.set(playerKey, {
          name: playerName || 'Anonymous',
          score: 0,
          currentAnswer: null,
          answerTime: null,
          isConnected: true,
          socketId: socket.id
        });
        socket.join('waiting-room');
        io.to('waiting-room').emit('player-joined', {
          playerCount: gameState.players.size,
          players: Array.from(gameState.players.values()).map(p => p.name)
        });
        // Also send to admin room so admin sees real-time updates
        io.to('admin').emit('player-joined', {
          playerCount: gameState.players.size,
          players: Array.from(gameState.players.values()).map(p => p.name)
        });
        console.log(`Player ${playerName} joined with socket ${socket.id}`);
      }
    }
  });
  
  socket.on('start-game', (data) => {
    const { token, playerEmail } = data;
    if (activeTokens.has(token) && playerEmail === 'hugues.journeau@databricks.com') {
      gameState.isStarted = true;
      gameState.currentPhase = 'photos';
      gameState.currentQuestion = 0;
      gameState.photoTimeLeft = 10;
      
      // Start photo display phase - send to both admin and players
      io.to('admin').emit('game-started', { phase: 'photos', question: gameState.currentQuestion });
      io.to('waiting-room').emit('game-started', { phase: 'photos', question: gameState.currentQuestion });
      
      // Start photo timer
      photoTimer = setInterval(() => {
        gameState.photoTimeLeft--;
        io.to('admin').emit('timer-update', { 
          phase: 'photos', 
          timeLeft: gameState.photoTimeLeft 
        });
        io.to('waiting-room').emit('timer-update', { 
          phase: 'photos', 
          timeLeft: gameState.photoTimeLeft 
        });
        
        if (gameState.photoTimeLeft <= 0) {
          clearInterval(photoTimer);
          startQuestionPhase();
        }
      }, 1000);
    } else {
      socket.emit('start-game-error', { message: 'Only admin can start the game' });
    }
  });
  
  socket.on('submit-answer', (data) => {
    const { answer, playerEmail } = data; // Remove timeLeft - we'll calculate server-side
    console.log(`Answer submission received from ${socket.id}:`, data);

    // Find player by email
    let player = null;
    for (const [key, p] of gameState.players) {
      if (p.name === playerEmail) {
        player = p;
        break;
      }
    }

    if (player && !player.currentAnswer) {
      player.currentAnswer = answer;
      
      // Calculate precise server-side timing
      const currentTime = Date.now();
      const timeElapsed = (currentTime - gameState.questionStartTime) / 1000; // Convert to seconds
      player.answerTime = Math.round(timeElapsed * 100) / 100; // Round to 2 decimal places
      
      console.log(`Player ${player.name} submitted answer: ${answer}, server time: ${player.answerTime}s`);
      io.emit('answer-submitted', { playerId: socket.id, playerName: player.name });

      // Check if all players have answered
      const allPlayersAnswered = Array.from(gameState.players.values()).every(p => p.currentAnswer !== null);
      if (allPlayersAnswered) {
        console.log('All players have answered, ending question early');
        gameState.questionEndTime = currentTime;
        // Clear the question timer to prevent double execution
        if (questionTimer) {
          clearInterval(questionTimer);
          questionTimer = null;
        }
        endQuestion();
      }
    } else {
      console.log(`Answer submission rejected for ${socket.id}: player=${!!player}, hasAnswer=${player?.currentAnswer}`);
    }
  });
  
  
  socket.on('reset-game', () => {
    // Reset game state
    gameState.isStarted = false;
    gameState.currentPhase = 'waiting';
    gameState.currentQuestion = 0;
    gameState.photoTimeLeft = 10;
    gameState.questionTimeLeft = 10;
    gameState.players.clear();
    gameState.leaderboard = [];
    
    // Clear all active tokens
    activeTokens.clear();
    
    // Notify all clients to redirect to landing page
    io.emit('game-reset');
  });

  socket.on('new-game', async (data) => {
    const { token, playerEmail } = data;
    if (activeTokens.has(token) && playerEmail === 'hugues.journeau@databricks.com') {
      console.log('Admin initiated new game - clearing all data');
      
      // Clear game_scores table
      await clearGameScores();
      
      // Reset game state
      gameState.isStarted = false;
      gameState.currentPhase = 'waiting';
      gameState.currentQuestion = 0;
      gameState.photoTimeLeft = 10;
      gameState.questionTimeLeft = 10;
      gameState.players.clear();
      gameState.leaderboard = [];
      
      // Clear all active tokens
      activeTokens.clear();
      
      // Clear timers
      if (photoTimer) {
        clearInterval(photoTimer);
        photoTimer = null;
      }
      if (questionTimer) {
        clearInterval(questionTimer);
        questionTimer = null;
      }
      
      // Notify all clients to redirect to landing page
      io.emit('game-reset');
      
      console.log('New game initiated - all data cleared');
    } else {
      socket.emit('new-game-error', { message: 'Only admin can start a new game' });
    }
  });

  socket.on('request-leaderboard', () => {
    console.log('Leaderboard requested, sending:', gameState.leaderboard);
    socket.emit('leaderboard-update', { leaderboard: gameState.leaderboard });
  });

  socket.on('request-player-count', () => {
    console.log('Player count requested');
    socket.emit('player-count-update', {
      playerCount: gameState.players.size,
      players: Array.from(gameState.players.values()).map(p => p.name)
    });
  });

  socket.on('rejoin-admin-room', (data) => {
    const { token, playerName } = data;
    if (activeTokens.has(token) && playerName === 'hugues.journeau@databricks.com') {
      socket.join('admin');
      console.log(`Admin ${playerName} rejoined admin room with socket ${socket.id}`);
    }
  });

  socket.on('rejoin-waiting-room', (data) => {
    const { token, playerName } = data;
    if (activeTokens.has(token)) {
      socket.join('waiting-room');
      console.log(`Player ${playerName} rejoined waiting room with socket ${socket.id}`);
    }
  });

  // Direct admin access for chat page (bypasses quiz authentication)
  socket.on('join-admin-direct', () => {
    socket.join('admin');
    socket.emit('admin-joined', { message: 'Admin connected for chat' });
    console.log(`Admin joined for chat with socket ${socket.id}`);
  });

  // Chatbot events
  socket.on('start-chatbot', async (data) => {
    // Check if this is an admin socket (in admin room)
    if (socket.rooms.has('admin')) {
      try {
        console.log('Testing Genie connection...');
        // Test the connection with a simple message
        const testResponse = await sendGenieMessage('Hello, can you help me with data questions?');
        
        socket.emit('chatbot-started', { 
          success: true, 
          message: 'Chatbot connected to Databricks Genie. You can now ask questions about your data!',
          testResponse: testResponse
        });
        
        console.log('Genie chatbot ready for admin');
      } catch (error) {
        console.error('Failed to connect to Genie:', error);
        socket.emit('chatbot-error', { 
          success: false, 
          message: `Failed to connect to Databricks Genie: ${error.response?.data?.message || error.message}` 
        });
      }
    } else {
      socket.emit('chatbot-error', { 
        success: false, 
        message: 'Only admin can access the chatbot.' 
      });
    }
  });

  socket.on('send-chatbot-message', async (data) => {
    const { message } = data;
    if (socket.rooms.has('admin')) {
      try {
        console.log(`Sending message to Genie: ${message}`);
        
        // Send message directly to Genie space
        const response = await sendGenieMessage(message);
        
        // Send immediate acknowledgment
        socket.emit('chatbot-response', {
          success: true,
          message: `🔄 Question submitted: "${message}"\n\n⏳ Waiting for Genie to process your request...`,
          timestamp: new Date().toISOString()
        });
        
        console.log('Response from Genie:', response);
        // Wait for the actual response using proper polling
        if (response.conversation_id && response.message_id) {
          console.log(`Polling for response: conversation=${response.conversation_id}, message=${response.message_id}`);
          const actualResponse = await waitForGenieResponse(
            response.conversation.space_id, 
            response.conversation_id, 
            response.message_id
          );
          
          socket.emit('chatbot-response', {
            success: true,
            message: actualResponse,
            timestamp: new Date().toISOString()
          });
        } else {
          socket.emit('chatbot-response', {
            success: false,
            message: '❌ No conversation or message ID received from Genie',
            timestamp: new Date().toISOString()
          });
        }
        
        console.log('Genie response sent to admin');
      } catch (error) {
        console.error('Failed to send message to Genie:', error);
        socket.emit('chatbot-response', {
          success: false,
          message: `❌ Failed to get response from Genie: ${error.response?.data?.message || error.message}`,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      socket.emit('chatbot-error', { 
        success: false, 
        message: 'Only admin can access the chatbot.' 
      });
    }
  });

  socket.on('disconnect', () => {
    // Find player by socket ID
    let player = null;
    for (const [key, p] of gameState.players) {
      if (p.socketId === socket.id) {
        player = p;
        break;
      }
    }
    
    if (player) {
      player.isConnected = false;
      io.to('waiting-room').emit('player-left', {
        playerCount: gameState.players.size,
        players: Array.from(gameState.players.values()).filter(p => p.isConnected).map(p => p.name)
      });
      // Also send to admin room so admin sees real-time updates
      io.to('admin').emit('player-left', {
        playerCount: gameState.players.size,
        players: Array.from(gameState.players.values()).filter(p => p.isConnected).map(p => p.name)
      });
    }
  });
});

function startQuestionPhase() {
  gameState.currentPhase = 'question';
  gameState.questionTimeLeft = 10;
  // Record server-side start time for precise timing
  gameState.questionStartTime = Date.now();
  console.log('Question phase started at:', gameState.questionStartTime);

  // Send same events to both admin and players
  io.to('admin').emit('phase-changed', {
    phase: 'question',
    question: gameState.currentQuestion
  });
  io.to('waiting-room').emit('phase-changed', {
    phase: 'question',
    question: gameState.currentQuestion
  });
  
  // Start question timer
  questionTimer = setInterval(() => {
    gameState.questionTimeLeft--;
    io.to('admin').emit('timer-update', { 
      phase: 'question', 
      timeLeft: gameState.questionTimeLeft 
    });
    io.to('waiting-room').emit('timer-update', { 
      phase: 'question', 
      timeLeft: gameState.questionTimeLeft 
    });
    
    if (gameState.questionTimeLeft <= 0) {
      clearInterval(questionTimer);
      questionTimer = null;
      gameState.questionEndTime = Date.now();
      endQuestion();
    }
  }, 1000);
}

function endQuestion() {
  // Simple game ID
  const gameId = 'espresso';
  console.log('Game ID:', gameId);
  
  // Calculate scores
  const correctAnswer = 'echantons'; // Fixed correct answer
  console.log('Correct answer is:', correctAnswer);
  let correctPlayers = [];
  
  // Store answers before clearing them
  const playerAnswers = new Map();
  gameState.players.forEach((player, playerKey) => {
    playerAnswers.set(player.name, {
      answer: player.currentAnswer,
      answerTime: player.answerTime
    });
  });
  
  gameState.players.forEach((player, playerKey) => {
    console.log(`Player ${player.name} answered: ${player.currentAnswer}, time: ${player.answerTime}`);
    if (player.currentAnswer === correctAnswer) {
      const score = Math.max(0, 10 - player.answerTime); // Faster = higher score
      player.score += score;
      correctPlayers.push({
        name: player.name,
        score: player.score,
        answerTime: player.answerTime
      });
    }
    player.currentAnswer = null;
    player.answerTime = null;
  });
  
  console.log('Correct players:', correctPlayers);
  
  // Sort by score (highest first)
  correctPlayers.sort((a, b) => b.score - a.score);
  gameState.leaderboard = correctPlayers;
  
  // Since there's only 1 question, go directly to leaderboard
  gameState.currentPhase = 'leaderboard';
  
  // Add ALL players to leaderboard (even with 0 score for wrong answers)
  console.log('Adding all players to leaderboard');
  gameState.players.forEach((player, playerKey) => {
    if (player.isConnected) {
      // Check if player is already in leaderboard (from correct answers)
      const existingPlayer = gameState.leaderboard.find(p => p.name === player.name);
      if (!existingPlayer) {
        // Calculate timeout time for players who didn't answer
        let answerTime = player.answerTime;
        if (!answerTime && gameState.questionEndTime) {
          // Player didn't answer - calculate timeout time
          const totalTime = (gameState.questionEndTime - gameState.questionStartTime) / 1000;
          answerTime = Math.round(totalTime * 100) / 100;
        }
        
        // Add player with 0 score (wrong answer or no answer)
        gameState.leaderboard.push({
          name: player.name,
          score: 0,
          answerTime: answerTime || null
        });
      }
    }
  });
  
  // Sort by score (highest first), then by answer time (fastest first) for ties
  gameState.leaderboard.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score; // Higher score first
    }
    // If scores are equal, faster answer time wins
    if (a.answerTime !== null && b.answerTime !== null) {
      return a.answerTime - b.answerTime;
    }
    return 0;
  });
  
  console.log('Final leaderboard being sent:', gameState.leaderboard);
  
  // Prepare results for Databricks logging
  const resultsToSave = [];
  gameState.players.forEach((player, playerKey) => {
    const leaderboardEntry = gameState.leaderboard.find(p => p.name === player.name);
    const rank = gameState.leaderboard.findIndex(p => p.name === player.name) + 1;
    const storedAnswer = playerAnswers.get(player.name);
    
    resultsToSave.push({
      email: player.name,
      answer: storedAnswer?.answer || 'timeout',
      answerTime: storedAnswer?.answerTime || (gameState.questionEndTime ? (gameState.questionEndTime - gameState.questionStartTime) / 1000 : 0),
      score: leaderboardEntry?.score || 0,
      rank: rank,
      isCorrect: storedAnswer?.answer === correctAnswer
    });
  });
  
  // Save results to Databricks (async, don't wait)
  saveQuizResults(gameId, resultsToSave).catch(error => {
    console.error('Failed to save quiz results:', error);
  });
  
  // Send different events based on user type
  // Admin gets the full leaderboard with controls
  console.log('Sending admin-game-ended to admin room');
  io.to('admin').emit('admin-game-ended', { leaderboard: gameState.leaderboard });
  
  // Also send to all sockets as fallback (admin will filter)
  console.log('Sending admin-game-ended-fallback to all sockets');
  io.emit('admin-game-ended-fallback', { leaderboard: gameState.leaderboard });
  
  // Players get their individual results
  gameState.players.forEach((player, playerKey) => {
    if (player.isConnected) {
      const playerRank = gameState.leaderboard.findIndex(p => p.name === player.name) + 1;
      const playerScore = gameState.leaderboard.find(p => p.name === player.name)?.score || 0;
      
      console.log(`Sending player-game-ended to ${player.name}: rank=${playerRank}, score=${playerScore}`);
      
      // Find the socket for this player
      const playerSocket = Array.from(io.sockets.sockets.values())
        .find(socket => socket.id === player.socketId);
      
      if (playerSocket) {
        console.log(`Found socket for ${player.name}: ${playerSocket.id}`);
        playerSocket.emit('player-game-ended', { 
          rank: playerRank, 
          score: playerScore,
          totalPlayers: gameState.leaderboard.length
        });
      } else {
        console.log(`No socket found for ${player.name} with socketId ${player.socketId}`);
        // Try to find by player name in waiting room
        const waitingRoomSockets = Array.from(io.sockets.adapter.rooms.get('waiting-room') || []);
        console.log('Waiting room sockets:', waitingRoomSockets);
      }
    }
  });
  
  // Fallback: Send to all waiting room sockets with player data
  console.log('Sending fallback player-game-ended to waiting room');
  io.to('waiting-room').emit('player-game-ended-fallback', { 
    leaderboard: gameState.leaderboard
  });
  
  // Also send to all sockets as ultimate fallback
  console.log('Sending player-game-ended-fallback to all sockets');
  io.emit('player-game-ended-fallback', { 
    leaderboard: gameState.leaderboard
  });
}

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Test database connection
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.warn('⚠️ Database connection failed, but server will continue with mock data');
  }
});
