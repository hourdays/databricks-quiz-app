const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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
  leaderboard: []
};

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
      const photoTimer = setInterval(() => {
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
    const { answer, timeLeft, playerEmail } = data;
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
      player.answerTime = 10 - timeLeft; // Time taken to answer
      console.log(`Player ${player.name} submitted answer: ${answer}, time: ${player.answerTime}`);
      io.emit('answer-submitted', { playerId: socket.id, playerName: player.name });
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
});

function startQuestionPhase() {
  gameState.currentPhase = 'question';
  gameState.questionTimeLeft = 10;
  
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
  const questionTimer = setInterval(() => {
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
  
  // Ensure we have some leaderboard data even if no one answered correctly
  if (gameState.leaderboard.length === 0) {
    console.log('No correct answers, adding all players with 0 score');
    // Add all players with 0 score if no one answered correctly
    gameState.players.forEach((player, playerKey) => {
      if (player.isConnected) {
        gameState.leaderboard.push({
          name: player.name,
          score: 0,
          answerTime: null
        });
      }
    });
  }
  
  // Sort by score (highest first)
  gameState.leaderboard.sort((a, b) => b.score - a.score);
  
  console.log('Final leaderboard being sent:', gameState.leaderboard);
  
  // Send different events based on user type
  // Admin gets the full leaderboard with controls
  io.to('admin').emit('admin-game-ended', { leaderboard: gameState.leaderboard });
  
  // Players get their individual results
  gameState.players.forEach((player, playerKey) => {
    if (player.isConnected) {
      const playerRank = gameState.leaderboard.findIndex(p => p.name === player.name) + 1;
      const playerScore = gameState.leaderboard.find(p => p.name === player.name)?.score || 0;
      
      // Find the socket for this player
      const playerSocket = Array.from(io.sockets.sockets.values())
        .find(socket => socket.id === player.socketId);
      
      if (playerSocket) {
        playerSocket.emit('player-game-ended', { 
          rank: playerRank, 
          score: playerScore,
          totalPlayers: gameState.leaderboard.length
        });
      }
    }
  });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
