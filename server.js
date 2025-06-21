const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Battle Categories
const CATEGORIES = {
    rap: [
        { id: 'best_2000s_rap', title: 'Best 2000s Rap Song', description: 'Pick the greatest rap song from 2000-2009' },
        { id: 'most_toxic_lyrics', title: 'Most Toxic Lyrics', description: 'The pettiest, most savage lyrics ever written' },
        { id: 'no_skip_album', title: 'Song from No-Skip Album', description: 'Pick any song from an album with zero skips' },
        { id: 'best_feature', title: 'Best Feature Verse', description: 'When the feature completely stole the show' },
        { id: 'perfect_beat', title: 'Perfect Beat', description: 'The beat that makes you move involuntarily' },
        { id: 'best_diss_track', title: 'Ultimate Diss Track', description: 'The most devastating diss in rap history' },
        { id: 'comeback_anthem', title: 'Comeback Anthem', description: 'The song that proves they\'re back on top' },
        { id: 'underrated_gem', title: 'Underrated Gem', description: 'The song that deserves way more recognition' }
    ],
    pop: [
        { id: 'guilty_pleasure', title: 'Guilty Pleasure', description: 'The pop song you secretly love but won\'t admit' },
        { id: 'best_breakup_song', title: 'Best Breakup Song', description: 'The song that gets you through heartbreak' },
        { id: 'dance_floor_filler', title: 'Dance Floor Filler', description: 'Guaranteed to get everyone moving' },
        { id: 'road_trip_banger', title: 'Road Trip Banger', description: 'Windows down, volume up vibes' },
        { id: 'shower_song', title: 'Shower Song', description: 'The song you belt out in the shower' },
        { id: 'throwback_thursday', title: 'Throwback Thursday', description: 'Takes you right back to the good old days' }
    ],
    rock: [
        { id: 'best_guitar_solo', title: 'Best Guitar Solo', description: 'The solo that gives you goosebumps every time' },
        { id: 'workout_motivation', title: 'Workout Motivation', description: 'Gets you pumped to lift heavy things' },
        { id: 'concert_opener', title: 'Perfect Concert Opener', description: 'The song that would get the crowd hyped' },
        { id: 'driving_at_night', title: 'Driving at Night', description: 'Perfect soundtrack for late-night drives' }
    ],
    rnb: [
        { id: 'smooth_vibes', title: 'Smoothest Vibes', description: 'The song that\'s pure silk to your ears' },
        { id: 'love_song', title: 'Ultimate Love Song', description: 'Makes you believe in romance again' },
        { id: '90s_rnb_classic', title: '90s R&B Classic', description: 'From the golden era of R&B' }
    ]
};

// In-memory game state
const rooms = new Map();
const players = new Map(); // socketId -> { name, roomCode, role }

// Utility functions
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoom(roomCode) {
    return rooms.get(roomCode);
}

function getRoomBySocket(socketId) {
    const player = players.get(socketId);
    if (!player) return null;
    return getRoom(player.roomCode);
}

function getRandomCategory(genre) {
    const categories = CATEGORIES[genre] || CATEGORIES.rap;
    return categories[Math.floor(Math.random() * categories.length)];
}

function selectBattlers(room) {
    const availablePlayers = Array.from(room.players.values());
    
    if (availablePlayers.length < 2) return null;
    
    // For now, just pick two random players
    // Later we can add king-of-the-hill logic
    const shuffled = availablePlayers.sort(() => 0.5 - Math.random());
    return {
        player1: shuffled[0],
        player2: shuffled[1]
    };
}

async function searchYouTube(songTitle, artist) {
    try {
        const query = encodeURIComponent(`${songTitle} ${artist}`);
        const apiKey = process.env.YOUTUBE_API_KEY;
        
        if (!apiKey) {
            console.error('YouTube API key not found');
            return null;
        }

        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&videoCategoryId=10&maxResults=3&key=${apiKey}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.items && data.items.length > 0) {
            // Return the first result that looks like a music video
            for (const item of data.items) {
                const title = item.snippet.title.toLowerCase();
                const description = item.snippet.description.toLowerCase();
                
                // Basic filtering for music content
                if (!title.includes('karaoke') && 
                    !title.includes('instrumental') && 
                    !title.includes('reaction') &&
                    !title.includes('review')) {
                    return {
                        videoId: item.id.videoId,
                        title: item.snippet.title,
                        thumbnail: item.snippet.thumbnails.medium.url,
                        channelTitle: item.snippet.channelTitle
                    };
                }
            }
            // If no filtered result, return first one
            return {
                videoId: data.items[0].id.videoId,
                title: data.items[0].snippet.title,
                thumbnail: data.items[0].snippet.thumbnails.medium.url,
                channelTitle: data.items[0].snippet.channelTitle
            };
        }
        
        return null;
    } catch (error) {
        console.error('YouTube search error:', error);
        return null;
    }
}

// Utility function to broadcast room updates
function broadcastRoomUpdate(roomCode) {
    const room = getRoom(roomCode);
    if (!room) return;

    const roomUpdate = {
        room: {
            code: room.code,
            host: room.host,
            players: Array.from(room.players.values()),
            gameState: room.gameState,
            settings: room.settings,
            scores: Object.fromEntries(room.scores),
            currentBattle: room.currentBattle
        }
    };

    io.to(roomCode).emit('room_updated', roomUpdate);
}

// Battle management functions
function startNewBattle(room) {
    const battlers = selectBattlers(room);
    if (!battlers) return;

    const category = getRandomCategory(room.settings.genre);
    
    room.currentBattle = {
        id: Date.now(),
        player1: battlers.player1,
        player2: battlers.player2,
        category: category,
        phase: 'submission', // submission, voting, results
        submissions: {},
        votes: new Map(),
        startTime: new Date()
    };

    room.gameState = 'battle';
    broadcastRoomUpdate(room.code);
}

function finishBattle(room) {
    const battle = room.currentBattle;
    
    // Count votes
    const voteCount = new Map();
    voteCount.set(battle.player1.id, 0);
    voteCount.set(battle.player2.id, 0);

    for (let [voter, votedFor] of battle.votes) {
        voteCount.set(votedFor, voteCount.get(votedFor) + 1);
    }

    // Determine winner
    const player1Votes = voteCount.get(battle.player1.id);
    const player2Votes = voteCount.get(battle.player2.id);
    
    let winnerId;
    if (player1Votes > player2Votes) {
        winnerId = battle.player1.id;
    } else if (player2Votes > player1Votes) {
        winnerId = battle.player2.id;
    } else {
        // Tie - random winner
        winnerId = Math.random() < 0.5 ? battle.player1.id : battle.player2.id;
    }

    // Update score
    const currentScore = room.scores.get(winnerId) || 0;
    room.scores.set(winnerId, currentScore + 1);

    battle.phase = 'results';
    battle.winner = winnerId;
    battle.finalVotes = { player1: player1Votes, player2: player2Votes };

    // Check for game winner
    if (currentScore + 1 >= room.settings.pointsToWin) {
        room.gameState = 'finished';
        battle.gameWinner = room.players.get(winnerId) || room.host;
    }

    broadcastRoomUpdate(room.code);
}

// Socket handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // HOST: Create room
    socket.on('create_room', (data) => {
        const { hostName } = data;
        const roomCode = generateRoomCode();
        
        const room = {
            code: roomCode,
            host: {
                id: socket.id,
                name: hostName
            },
            players: new Map(),
            gameState: 'lobby', // lobby, battle, finished
            settings: {
                genre: 'rap',
                pointsToWin: 5,
                maxPlayers: 8
            },
            scores: new Map(), // playerId -> score
            currentBattle: null,
            createdAt: new Date()
        };

        rooms.set(roomCode, room);
        players.set(socket.id, {
            name: hostName,
            roomCode: roomCode,
            role: 'host'
        });

        socket.join(roomCode);
        
        socket.emit('room_created', {
            success: true,
            roomCode: roomCode,
            role: 'host'
        });

        console.log(`Room ${roomCode} created by ${hostName}`);
    });

    // PLAYER: Join room
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = getRoom(roomCode);

        if (!room) {
            socket.emit('join_failed', { error: 'Room not found' });
            return;
        }

        if (room.players.size >= room.settings.maxPlayers) {
            socket.emit('join_failed', { error: 'Room is full' });
            return;
        }

        if (room.gameState !== 'lobby') {
            socket.emit('join_failed', { error: 'Game already in progress' });
            return;
        }

        // Check for duplicate names
        const existingNames = [room.host.name, ...Array.from(room.players.values()).map(p => p.name)];
        if (existingNames.includes(playerName)) {
            socket.emit('join_failed', { error: 'Name already taken' });
            return;
        }

        // Add player to room
        room.players.set(socket.id, {
            id: socket.id,
            name: playerName,
            joinedAt: new Date()
        });

        room.scores.set(socket.id, 0);

        players.set(socket.id, {
            name: playerName,
            roomCode: roomCode,
            role: 'player'
        });

        socket.join(roomCode);

        // Notify player they joined
        socket.emit('room_joined', {
            success: true,
            roomCode: roomCode,
            role: 'player'
        });

        // Update everyone in room
        broadcastRoomUpdate(roomCode);

        console.log(`${playerName} joined room ${roomCode}`);
    });

    // Get current room state
    socket.on('get_room_state', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) {
            socket.emit('room_state', { error: 'Not in any room' });
            return;
        }

        const playerData = players.get(socket.id);
        socket.emit('room_state', {
            room: {
                code: room.code,
                host: room.host,
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                settings: room.settings,
                scores: Object.fromEntries(room.scores),
                currentBattle: room.currentBattle
            },
            yourRole: playerData.role,
            yourName: playerData.name
        });
    });

    // HOST: Update game settings
    socket.on('update_settings', (data) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.host.id !== socket.id) {
            socket.emit('error', { message: 'Not authorized' });
            return;
        }

        room.settings = { ...room.settings, ...data };
        broadcastRoomUpdate(room.code);
        
        console.log(`Settings updated in room ${room.code}`);
    });

    // HOST: Start game
    socket.on('start_game', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.host.id !== socket.id) {
            socket.emit('error', { message: 'Not authorized' });
            return;
        }

        if (room.players.size < 2) {
            socket.emit('error', { message: 'Need at least 2 players to start' });
            return;
        }

        // Start first battle
        startNewBattle(room);
        
        console.log(`Game started in room ${room.code}`);
    });

    // BATTLE: Submit song
    socket.on('submit_song', async (data) => {
        const { title, artist } = data;
        const room = getRoomBySocket(socket.id);
        
        if (!room || !room.currentBattle) {
            socket.emit('error', { message: 'No active battle' });
            return;
        }
    
        const battle = room.currentBattle;
        
        // Check if this player is a battler
        let isPlayer1 = battle.player1.id === socket.id;
        let isPlayer2 = battle.player2.id === socket.id;
        
        if (!isPlayer1 && !isPlayer2) {
            socket.emit('error', { message: 'You are not battling in this round' });
            return;
        }
    
        // Search for YouTube video
        console.log(`Searching YouTube for: ${title} by ${artist}`);
        const youtubeData = await searchYouTube(title, artist);
        
        const submission = {
            title,
            artist,
            submittedAt: new Date(),
            youtube: youtubeData
        };
    
        if (isPlayer1) {
            battle.submissions.player1 = submission;
            console.log(`Player 1 submitted: ${title} - YouTube: ${youtubeData ? youtubeData.videoId : 'Not found'}`);
        } else {
            battle.submissions.player2 = submission;
            console.log(`Player 2 submitted: ${title} - YouTube: ${youtubeData ? youtubeData.videoId : 'Not found'}`);
        }
    
        // Check if both songs submitted
        if (battle.submissions.player1 && battle.submissions.player2) {
            battle.phase = 'voting';
            battle.votingStartTime = new Date();
            console.log('Both songs submitted, moving to voting phase');
        }
    
        broadcastRoomUpdate(room.code);
        console.log(`Song submitted in room ${room.code}`);
    });

    // BATTLE: Submit vote
    socket.on('submit_vote', (data) => {
        const { votedPlayerId } = data;
        const room = getRoomBySocket(socket.id);
        
        if (!room || !room.currentBattle) {
            socket.emit('error', { message: 'No active battle' });
            return;
        }

        const battle = room.currentBattle;
        
        if (battle.phase !== 'voting') {
            socket.emit('error', { message: 'Voting not active' });
            return;
        }

        // Can't vote if you're battling
        if (battle.player1.id === socket.id || battle.player2.id === socket.id) {
            socket.emit('error', { message: 'Battlers cannot vote' });
            return;
        }

        // Record vote
        battle.votes.set(socket.id, votedPlayerId);

        // Check if everyone voted
        const totalJudges = room.players.size - 2 + (room.host.id !== battle.player1.id && room.host.id !== battle.player2.id ? 1 : 0);
        
        if (battle.votes.size >= totalJudges) {
            finishBattle(room);
        }

        broadcastRoomUpdate(room.code);
        console.log(`Vote submitted in room ${room.code}`);
    });

    // HOST: Next battle
    socket.on('next_battle', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.host.id !== socket.id) {
            socket.emit('error', { message: 'Not authorized' });
            return;
        }

        startNewBattle(room);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const playerData = players.get(socket.id);
        if (!playerData) return;

        const room = getRoom(playerData.roomCode);
        if (!room) return;

        if (playerData.role === 'host') {
            // Host left - close room
            io.to(playerData.roomCode).emit('room_closed', { 
                message: 'Host left the room' 
            });
            
            // Clean up all players
            for (let playerId of room.players.keys()) {
                players.delete(playerId);
            }
            
            rooms.delete(playerData.roomCode);
            console.log(`Room ${playerData.roomCode} closed - host left`);
        } else {
            // Player left
            room.players.delete(socket.id);
            room.scores.delete(socket.id);
            broadcastRoomUpdate(playerData.roomCode);
            console.log(`${playerData.name} left room ${playerData.roomCode}`);
        }

        players.delete(socket.id);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`🎵 Song Wars running on http://localhost:${PORT}`);
    console.log('🎮 Modern single-page multiplayer ready!');
});