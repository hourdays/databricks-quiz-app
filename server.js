const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

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

// Generate 6-digit access token
app.post('/api/token', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  // Generate 6-digit token
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  activeTokens.add(token);
  
  res.json({ token });
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
  // Calculate scores
  const correctAnswer = 'echantons'; // Fixed correct answer
  console.log('Correct answer is:', correctAnswer);
  let correctPlayers = [];
  
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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
