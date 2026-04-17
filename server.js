const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require('./grand-line-tcg-firebase-adminsdk-fbsvc-e3b6828848.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://grand-line-tcg-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "http://localhost:3000" } });

app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'one_piece_cards', allowed_formats: ['jpg', 'jpeg', 'png'] }
});
const upload = multer({ storage: storage });

// Middleware to verify Firebase Token
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("No token");
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).send("Invalid token");
  }
};

// --- AUTHENTICATION ---
app.post('/api/auth/sync', verifyToken, async (req, res) => {
  const { username } = req.body;
  const userRef = db.ref('users/' + req.user.uid);
  const snap = await userRef.once('value');
  if (!snap.exists()) {
    await userRef.set({ username, isAdmin: false, collection: [] });
  }
  const userData = (await userRef.once('value')).val();
  let isAdmin = false;
  try {
    const userRecord = await admin.auth().getUser(req.user.uid);
    isAdmin = !!userRecord.customClaims?.admin;
  } catch(e) {}
  res.json({ id: req.user.uid, ...userData, isAdmin });
});

// --- DECK MANAGEMENT ---
app.post('/api/decks/save', verifyToken, async (req, res) => {
  try {
    const { name, cards } = req.body;
    const newDeckRef = db.ref('decks').push();
    await newDeckRef.set({ userId: req.user.uid, name, cards });
    res.status(201).json({ _id: newDeckRef.key, userId: req.user.uid, name, cards });
  } catch (err) { res.status(500).send(); }
});

app.get('/api/decks/:userId', async (req, res) => {
  const snap = await db.ref('decks').orderByChild('userId').equalTo(req.params.userId).once('value');
  const decks = [];
  snap.forEach(child => { decks.push({ _id: child.key, ...child.val() }); });
  res.json(decks);
});

app.put('/api/decks/:id', verifyToken, async (req, res) => {
  try {
    const { name, cards } = req.body;
    await db.ref('decks/' + req.params.id).update({ name, cards });
    res.status(200).send();
  } catch (err) { res.status(500).send(); }
});

app.delete('/api/decks/:id', verifyToken, async (req, res) => {
  await db.ref('decks/' + req.params.id).remove();
  res.status(200).send();
});

// --- GACHA ---
app.post('/api/user/open-pack', verifyToken, async (req, res) => {
  try {
    const cardsSnap = await db.ref('cards').once('value');
    const allCards = [];
    if(cardsSnap.exists()){
       cardsSnap.forEach(c => { allCards.push({ _id: c.key, ...c.val() }); });
    }
    
    // NEW RARITY LOGIC
    const blueMoon = allCards.filter(c => c.rarity === 'Blue Moon');
    const ultraRare = allCards.filter(c => c.rarity === 'Ultra rare');
    const rare = allCards.filter(c => c.rarity === 'Rare');
    const common = allCards.filter(c => c.rarity === 'Common');
    
    const newCards = [];
    for(let i=0; i<5; i++) {
      const roll = Math.random() * 100;
      if (roll < 1 && blueMoon.length > 0) newCards.push(blueMoon[Math.floor(Math.random() * blueMoon.length)]);
      else if (roll < 5 && ultraRare.length > 0) newCards.push(ultraRare[Math.floor(Math.random() * ultraRare.length)]);
      else if (roll < 25 && rare.length > 0) newCards.push(rare[Math.floor(Math.random() * rare.length)]);
      else if (common.length > 0) newCards.push(common[Math.floor(Math.random() * common.length)]);
    }
    
    const userRef = db.ref('users/' + req.user.uid + '/collection');
    const existingSnap = await userRef.once('value');
    let collection = existingSnap.val() || [];
    collection = [...collection, ...newCards.filter(Boolean)];
    await userRef.set(collection);
    
    res.json(collection);
  } catch (err) { res.status(500).send(); }
});

// --- ADMIN (CRUD) ---
app.get('/api/admin/users', verifyToken, async (req, res) => {
  try {
     const list = await admin.auth().listUsers();
     const users = list.users.map(u => ({ _id: u.uid, username: u.email }));
     res.json(users);
  } catch(e) { res.status(500).send(); }
});

app.delete('/api/admin/user/:id', verifyToken, async (req, res) => {
  await admin.auth().deleteUser(req.params.id);
  await db.ref('users/' + req.params.id).remove();
  res.status(200).send();
});

app.post('/api/admin/add-card', upload.single('image'), async (req, res) => {
  try {
    const { name, type, rarity, hp, attacks } = req.body;
    const newCard = { name, type, rarity, hp: Number(hp), attacks: JSON.parse(attacks), imageUrl: req.file.path };
    const newRef = db.ref('cards').push();
    await newRef.set(newCard);
    res.status(201).send();
  } catch (error) { res.status(500).send(); }
});

app.put('/api/admin/update-card/:id', upload.single('image'), async (req, res) => {
  try {
    const { name, type, rarity, hp, attacks } = req.body;
    const updateData = { name, type, rarity, hp: Number(hp), attacks: JSON.parse(attacks) };
    if (req.file) updateData.imageUrl = req.file.path;
    await db.ref('cards/' + req.params.id).update(updateData);

    // CASCADE UPDATE TO ALL USERS AND DECKS
    const cardId = req.params.id;
    const usersSnap = await db.ref('users').once('value');
    if (usersSnap.exists()) {
      const users = usersSnap.val();
      for (const uid in users) {
        if (users[uid].collection) {
           let changed = false;
           const newCol = users[uid].collection.map(c => {
             if (c && c._id === cardId) { changed = true; return { ...c, ...updateData }; }
             return c;
           });
           if (changed) await db.ref('users/' + uid + '/collection').set(newCol);
        }
      }
    }

    const decksSnap = await db.ref('decks').once('value');
    if (decksSnap.exists()) {
      const decks = decksSnap.val();
      for (const did in decks) {
        if (decks[did].cards) {
          let changed = false;
          const newCards = decks[did].cards.map(c => {
            if (c && c._id === cardId) { changed = true; return { ...c, ...updateData }; }
            return c;
          });
          if (changed) await db.ref('decks/' + did + '/cards').set(newCards);
        }
      }
    }

    res.status(200).send();
  } catch (error) { res.status(500).send(); }
});

app.delete('/api/admin/card/:id', async (req, res) => { 
  const cardId = req.params.id;
  await db.ref('cards/' + cardId).remove(); 
  
  // CASCADE DELETE TO ALL USERS AND DECKS
  const usersSnap = await db.ref('users').once('value');
  if (usersSnap.exists()) {
    const users = usersSnap.val();
    for (const uid in users) {
      if (users[uid].collection) {
         const newCol = users[uid].collection.filter(c => c && c._id !== cardId);
         if (newCol.length !== users[uid].collection.length) await db.ref('users/' + uid + '/collection').set(newCol);
      }
    }
  }

  const decksSnap = await db.ref('decks').once('value');
  if (decksSnap.exists()) {
    const decks = decksSnap.val();
    for (const did in decks) {
      if (decks[did].cards) {
        const newCards = decks[did].cards.filter(c => c && c._id !== cardId);
        if (newCards.length !== decks[did].cards.length) await db.ref('decks/' + did + '/cards').set(newCards);
      }
    }
  }

  res.status(200).send(); 
});

app.get('/api/cards', async (req, res) => {
  const snap = await db.ref('cards').once('value');
  const allCards = [];
  if (snap.exists()) {
    snap.forEach(c => { allCards.push({ _id: c.key, ...c.val() }); });
  }
  res.json(allCards);
});

const games = {};
const socketRoomMap = {};

setInterval(() => {
  for (const roomId in games) {
    const gameState = games[roomId];
    const ids = Object.keys(gameState.players);
    if (ids.length === 2 && !gameState.gameOver) {
      if (gameState.timer > 0) gameState.timer--; else switchTurn(gameState);
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  }
}, 1000);

function switchTurn(gameState) {
  const ids = Object.keys(gameState.players);
  if (ids.length < 2) return;
  gameState.turn = (gameState.turn + 1) % ids.length;
  gameState.timer = 60;
  const next = gameState.players[ids[gameState.turn]];
  if(next) next.hasAttacked = false; 
  if (next && next.deck.length > 0) {
    next.hand.push(next.deck.splice(Math.floor(Math.random() * next.deck.length), 1)[0]);
  }
  gameState.board.forEach(c => { if (c.owner === next.id) c.energyPool += 10; });
}

io.on('connection', (socket) => {
  socket.on('joinGame', ({ deck, username }) => {
    let roomId = Object.keys(games).find(id => Object.keys(games[id].players).length === 1);
    if (!roomId) {
      roomId = Math.random().toString(36).substr(2, 9);
      games[roomId] = { players: {}, board: [], turn: 0, timer: 60, gameOver: false, winner: null };
    }
    socket.join(roomId);
    socketRoomMap[socket.id] = roomId;
    const gameState = games[roomId];

    if (Object.keys(gameState.players).length < 2) {
      const chars = deck.filter(c => c.type === 'Character');
      const traitorId = chars.length > 0 ? chars[Math.floor(Math.random() * chars.length)]._id : null;
      
      gameState.players[socket.id] = { id: socket.id, username, deck, hand: [], kills: 0, hasAttacked: false, traitorCardId: traitorId };
      if (Object.keys(gameState.players).length === 2) gameState.timer = 60;
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  });

  socket.on('playCard', ({ cardId, slotId }) => {
    const roomId = socketRoomMap[socket.id];
    const gameState = games[roomId];
    if (!gameState) return;

    const p = gameState.players[socket.id];
    if (!p || socket.id !== Object.keys(gameState.players)[gameState.turn]) return;
    if (!slotId) return;

    // Reject if slot is occupied
    if (gameState.board.some(c => c.owner === socket.id && c.slotId === slotId)) return;

    const idx = p.hand.findIndex(c => c._id === cardId);
    if (idx > -1) {
      const card = p.hand.splice(idx, 1)[0];
      
      let isTraitor = false;
      if (card._id === p.traitorCardId) {
         if (slotId === 'captain') {
            const otherChars = [...p.hand, ...p.deck].filter(c => c.type === 'Character' && c._id !== card._id);
            if (otherChars.length > 0) p.traitorCardId = otherChars[Math.floor(Math.random() * otherChars.length)]._id;
         } else {
            isTraitor = true;
         }
      }

      gameState.board.push({ ...card, _id: Math.random().toString(36).substr(2,9), owner: socket.id, energyPool: 10, hakiBuff: 0, maxHp: card.hp, slotId, isTraitor, attackCount: 0 });
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  });

  socket.on('performAttack', ({ attackerId, targetId, attackIndex }) => {
    const roomId = socketRoomMap[socket.id];
    const gameState = games[roomId];
    if (!gameState) return;

    const player = gameState.players[socket.id];
    if (!player || player.hasAttacked || socket.id !== Object.keys(gameState.players)[gameState.turn]) return;
    
    const atk = gameState.board.find(c => c._id === attackerId);
    const tar = gameState.board.find(c => c._id === targetId);
    
    if (atk && tar && atk.owner === socket.id) {
      const attackerSlotType = atk.slotId.split('-')[0];
      const targetSlotType = tar.slotId.split('-')[0];

      // Targeting Rules
      if (targetSlotType === 'healer') {
        if (attackerSlotType === 'captain' || attackerSlotType === 'vice') return; // vice-captain cannot attack healer
      } else if (attackerSlotType !== targetSlotType) {
        return; // Exact matches required for the rest
      }

      const move = atk.attacks ? atk.attacks[attackIndex] : null;
      if (!move) return;
      if (atk.energyPool >= Number(move.energyRequired)) {
        atk.energyPool -= move.energyRequired;
        atk.attackCount = (atk.attackCount || 0) + 1;
        
        // Traitor Logic
        if (atk.isTraitor && atk.attackCount === 3) {
           atk.hp = atk.maxHp;
           atk.owner = Object.keys(gameState.players).find(id => id !== atk.owner);
           atk.isTraitor = false;
           // Swap to enemy side slot
           const possibleSlots = ['tank-1','tank-2','support-1','support-2','support-3','vice-captain','healer','captain', 'traitor-extra'];
           const occupied = gameState.board.filter(c => c.owner === atk.owner).map(c => c.slotId);
           atk.slotId = possibleSlots.find(s => !occupied.includes(s)) || 'traitor-extra';
           
           player.hasAttacked = true;
           io.to(roomId).emit('gameStateUpdate', gameState);
           setTimeout(() => switchTurn(gameState), 1000); 
           return;
        }

        tar.hp -= (Number(move.damage) + (atk.hakiBuff || 0)); 
        player.hasAttacked = true;
        
        if (tar.hp <= 0) {
          gameState.board = gameState.board.filter(c => c._id !== targetId);
          let points = targetSlotType === 'captain' ? 3 : 1;
          gameState.players[socket.id].kills += points;
          if (gameState.players[socket.id].kills >= 5) { gameState.gameOver = true; gameState.winner = socket.id; }
        }
        
        io.to(roomId).emit('gameStateUpdate', gameState);
        setTimeout(() => switchTurn(gameState), 1000); 
      }
    }
  });

  socket.on('applyHaki', ({ targetId, bonus }) => {
    const roomId = socketRoomMap[socket.id];
    const gameState = games[roomId];
    if (!gameState) return;

    const target = gameState.board.find(c => c._id === targetId);
    if (target && target.owner === socket.id) {
      target.hakiBuff += bonus; 
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  });

  socket.on('endTurn', () => {
    const roomId = socketRoomMap[socket.id];
    const gameState = games[roomId];
    if (!gameState) return;

    if (socket.id === Object.keys(gameState.players)[gameState.turn]) {
      switchTurn(gameState);
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  });

  socket.on('restartGame', () => {
    const roomId = socketRoomMap[socket.id];
    if (!roomId) return;
    games[roomId] = { players: {}, board: [], turn: 0, timer: 60, gameOver: false, winner: null };
    io.to(roomId).emit('gameStateUpdate', games[roomId]);
  });

  socket.on('disconnect', () => { 
    const roomId = socketRoomMap[socket.id];
    if (roomId && games[roomId]) {
      delete games[roomId].players[socket.id];
      io.to(roomId).emit('gameStateUpdate', games[roomId]);
      if (Object.keys(games[roomId].players).length === 0) {
        delete games[roomId];
      }
    }
    delete socketRoomMap[socket.id];
  });
});

const PORT = process.env.PORT || 5005;
server.listen(PORT, () => console.log(`Grand Line Server Running on port ${PORT} (Firebase Edition)`));