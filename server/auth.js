const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-123';
const USERS_FILE = path.join(__dirname, 'users.json');

// Load users
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      const defaultUsers = {
        users: [{
          id: 'admin1',
          email: 'admin@autobackend.com',
          password: bcrypt.hashSync('admin123', 10),
          name: 'Admin',
          role: 'admin',
          createdAt: new Date().toISOString()
        }]
      };
      fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
      return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    console.error('Error loading users:', e);
    return { users: [] };
  }
}

// Save users
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// Hash password
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

// Compare password
async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// Generate JWT
function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email,
      role: user.role 
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Verify JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Admin only middleware
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required' });
  }
}

// Register new user
async function registerUser(email, password, name) {
  const data = loadUsers();
  
  if (data.users.find(u => u.email === email)) {
    throw new Error('User already exists');
  }
  
  const hashedPassword = await hashPassword(password);
  
  const newUser = {
    id: uuidv4(),
    email,
    password: hashedPassword,
    name,
    role: 'user',
    createdAt: new Date().toISOString()
  };
  
  data.users.push(newUser);
  saveUsers(data);
  
  const { password: _, ...userWithoutPassword } = newUser;
  return userWithoutPassword;
}

// Login user
async function loginUser(email, password) {
  const data = loadUsers();
  const user = data.users.find(u => u.email === email);
  
  if (!user) {
    throw new Error('User not found');
  }
  
  const valid = await comparePassword(password, user.password);
  if (!valid) {
    throw new Error('Invalid password');
  }
  
  const { password: _, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

module.exports = {
  authenticateToken,
  requireAdmin,
  registerUser,
  loginUser,
  generateToken,
  loadUsers
};