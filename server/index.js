const express = require('express');
const multer = require('multer');
const admZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// PRODUCTION PATH CONFIGURATION
// ============================================
const IS_RAILWAY = process.env.RAILWAY_VOLUME_MOUNT_PATH ? true : false;
const BASE_PATH = IS_RAILWAY ? '/app/data' : path.join(__dirname, '..');

const DATA_PATH = BASE_PATH;
const UPLOAD_PATH = path.join(DATA_PATH, 'uploads');
const DEPLOY_PATH = path.join(DATA_PATH, 'deploy');
const LOGS_PATH = path.join(DATA_PATH, 'logs');
const APPS_META_PATH = path.join(DATA_PATH, 'apps.json');

// Ensure directories exist
[DATA_PATH, UPLOAD_PATH, DEPLOY_PATH, LOGS_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});

// Initialize apps metadata
if (!fs.existsSync(APPS_META_PATH)) {
  fs.writeFileSync(APPS_META_PATH, JSON.stringify({}));
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({ 
  dest: UPLOAD_PATH,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Store deployment status
const deployments = new Map();

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await auth.registerUser(email, password, name || email.split('@')[0]);
    const token = auth.generateToken(user);
    
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    
    res.json({
      message: 'User created',
      user,
      token
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await auth.loginUser(email, password);
    const token = auth.generateToken(user);
    
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    
    res.json({
      message: 'Login successful',
      user,
      token
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/auth/me', auth.authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// ============================================
// UPLOAD ENDPOINT
// ============================================
app.post('/api/upload', auth.authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploadId = uuidv4();
    const extractPath = path.join(UPLOAD_PATH, uploadId);
    
    // Extract ZIP
    const zip = new admZip(file.path);
    zip.extractAllTo(extractPath, true);
    
    // Clean up uploaded zip
    fs.unlinkSync(file.path);
    
    // Detect frontend type
    const files = fs.readdirSync(extractPath);
    let frontendType = 'unknown';
    
    if (files.includes('index.html')) {
      const hasStaticFolder = files.includes('static') || 
                             files.some(f => f.startsWith('static.') || 
                                       (fs.existsSync(path.join(extractPath, 'assets'))));
      frontendType = hasStaticFolder ? 'spa' : 'static';
    }
    
    res.json({
      success: true,
      uploadId,
      frontendType,
      fileCount: files.length
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET TEMPLATES
// ============================================
app.get('/api/templates', (req, res) => {
  const templates = [
    { id: 'blog', name: 'Blog / CMS', description: 'Posts, comments, users', icon: '📝' },
    { id: 'ecom', name: 'E-commerce', description: 'Products, cart, orders', icon: '🛒' },
    { id: 'crud', name: 'Dashboard / CRUD', description: 'Data tables, charts', icon: '📊' }
  ];
  res.json({ templates });
});

// ============================================
// DEPLOY ENDPOINT
// ============================================
app.post('/api/deploy', auth.authenticateToken, async (req, res) => {
  try {
    const { uploadId, templateId, name } = req.body;
    const userId = req.user.id;
    
    if (!uploadId || !templateId) {
      return res.status(400).json({ error: 'Missing uploadId or templateId' });
    }
    
    const appId = `app_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const sourcePath = path.join(UPLOAD_PATH, uploadId);
    
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    // Start deployment (async)
    deployments.set(appId, { status: 'starting', progress: 0, ownerId: userId });
    
    // Trigger async deployment
    deployApp(sourcePath, templateId, appId, userId, name).catch(err => {
      console.error('Deployment failed:', err);
      deployments.set(appId, { status: 'failed', error: err.message, ownerId: userId });
    });
    
    res.json({
      success: true,
      appId,
      message: 'Deployment started',
      url: `/apps/${appId}`
    });
    
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DEPLOYMENT STATUS
// ============================================
app.get('/api/status/:appId', auth.authenticateToken, (req, res) => {
  const { appId } = req.params;
  const status = deployments.get(appId) || { status: 'not_found' };
  
  // Only return if user owns it or is admin
  if (status.ownerId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  res.json(status);
});

// ============================================
// GET USER'S APPS
// ============================================
app.get('/api/myapps', auth.authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const userApps = [];
    
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    
    for (const [appId, meta] of Object.entries(appsMeta)) {
      if (meta.ownerId === userId) {
        const deployPath = path.join(DEPLOY_PATH, appId);
        const dbPath = path.join(deployPath, 'db.json');
        let dbStats = { size: 0, collections: 0, totalRecords: 0 };
        
        try {
          if (fs.existsSync(dbPath)) {
            const stats = fs.statSync(dbPath);
            dbStats.size = stats.size;
            const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            dbStats.collections = Object.keys(db).length;
            dbStats.totalRecords = Object.values(db).reduce((acc, val) => 
              acc + (Array.isArray(val) ? val.length : 0), 0);
          }
        } catch (e) {}
        
        const appInfo = deployments.get(appId);
        userApps.push({
          id: appId,
          ...meta,
          status: appInfo ? appInfo.status : 'stopped',
          url: `/apps/${appId}`,
          dbStats
        });
      }
    }
    
    res.json({ apps: userApps });
  } catch (error) {
    console.error('Error loading apps:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================
app.get('/api/admin/apps', auth.authenticateToken, auth.requireAdmin, (req, res) => {
  try {
    const apps = [];
    const users = auth.loadUsers();
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    
    for (const [appId, info] of deployments) {
      const meta = appsMeta[appId] || {};
      const owner = users.users.find(u => u.id === meta.ownerId);
      
      const deployPath = path.join(DEPLOY_PATH, appId);
      const dbPath = path.join(deployPath, 'db.json');
      let dbStats = { size: 0, collections: 0, totalRecords: 0 };
      
      try {
        if (fs.existsSync(dbPath)) {
          const stats = fs.statSync(dbPath);
          dbStats.size = stats.size;
          const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
          dbStats.collections = Object.keys(db).length;
          dbStats.totalRecords = Object.values(db).reduce((acc, val) => 
            acc + (Array.isArray(val) ? val.length : 0), 0);
        }
      } catch (e) {}
      
      apps.push({
        id: appId,
        ...info,
        ...meta,
        owner: owner ? { email: owner.email, name: owner.name } : { email: 'unknown' },
        dbStats,
        url: `/apps/${appId}`
      });
    }
    
    res.json({ apps });
  } catch (error) {
    console.error('Admin error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DELETE APP - FIXED VERSION
// ============================================
app.post('/api/admin/apps/:appId/delete', auth.authenticateToken, async (req, res) => {
  try {
    const { appId } = req.params;
    
    console.log(`🗑️ Attempting to delete app: ${appId}`);
    
    // Check if user is admin OR owns the app
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    const appMeta = appsMeta[appId];
    
    if (!appMeta) {
      return res.status(404).json({ error: 'App not found in metadata' });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && appMeta.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Remove from running apps (if exists)
    if (deployments.has(appId)) {
      deployments.delete(appId);
    }
    
    // Delete physical files
    const deployPath = path.join(DEPLOY_PATH, appId);
    if (fs.existsSync(deployPath)) {
      console.log(`📁 Deleting folder: ${deployPath}`);
      fs.rmSync(deployPath, { recursive: true, force: true });
    } else {
      console.log(`📁 Folder not found: ${deployPath}`);
    }
    
    // Remove from apps.json
    delete appsMeta[appId];
    fs.writeFileSync(APPS_META_PATH, JSON.stringify(appsMeta, null, 2));
    
    console.log(`✅ App ${appId} deleted successfully`);
    res.json({ success: true, message: 'App deleted', appId });
    
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// USER DELETE THEIR OWN APP
// ============================================
app.post('/api/apps/:appId/delete', auth.authenticateToken, async (req, res) => {
  try {
    const { appId } = req.params;
    
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    const appMeta = appsMeta[appId];
    
    if (!appMeta) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    // Check if user owns this app
    if (appMeta.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this app' });
    }
    
    // Remove from running apps
    deployments.delete(appId);
    
    // Delete files
    const deployPath = path.join(DEPLOY_PATH, appId);
    if (fs.existsSync(deployPath)) {
      fs.rmSync(deployPath, { recursive: true, force: true });
    }
    
    // Remove from metadata
    delete appsMeta[appId];
    fs.writeFileSync(APPS_META_PATH, JSON.stringify(appsMeta, null, 2));
    
    res.json({ success: true, message: 'App deleted' });
    
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STOP APP
// ============================================
app.post('/api/admin/apps/:appId/stop', auth.authenticateToken, auth.requireAdmin, (req, res) => {
  const { appId } = req.params;
  const appInfo = deployments.get(appId);
  
  if (!appInfo) {
    return res.status(404).json({ error: 'App not running' });
  }
  
  deployments.delete(appId);
  
  res.json({ message: 'App stopped', appId });
});

// ============================================
// APP API ROUTES (Universal CRUD)
// ============================================
app.use('/api/:appId/*', auth.authenticateToken, (req, res) => {
  try {
    const { appId } = req.params;
    const collection = req.params[0] || '';
    const dbPath = path.join(DEPLOY_PATH, appId, 'db.json');
    
    // Check if user owns this app
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    const appMeta = appsMeta[appId];
    
    if (!appMeta) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    if (appMeta.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'App database not found' });
    }
    
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    
    switch (req.method) {
      case 'GET':
        if (collection) {
          res.json(db[collection] || []);
        } else {
          res.json({ collections: Object.keys(db) });
        }
        break;
        
      case 'POST':
        if (collection) {
          if (!db[collection]) db[collection] = [];
          
          const newItem = {
            id: Date.now().toString(),
            ...req.body,
            createdAt: new Date().toISOString()
          };
          
          db[collection].push(newItem);
          fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
          res.status(201).json(newItem);
        } else {
          res.status(400).json({ error: 'Collection name required' });
        }
        break;
        
      default:
        res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SERVE DEPLOYED APPS - FIXED VERSION
// ============================================
app.use('/apps/:appId', (req, res, next) => {
  const { appId } = req.params;
  
  console.log(`🔍 Looking for app: ${appId}`);
  
  const appBasePath = path.join(DEPLOY_PATH, appId);
  const frontendPath = path.join(appBasePath, 'frontend');
  
  // Try multiple possible paths
  let appPath = null;
  let indexPath = null;
  
  // Check frontend folder first
  if (fs.existsSync(frontendPath)) {
    // Look for index.html in frontend
    const possibleIndexPaths = [
      path.join(frontendPath, 'index.html'),
      path.join(frontendPath, 'testapp', 'index.html'),
      path.join(frontendPath, 'public', 'index.html'),
      path.join(frontendPath, 'dist', 'index.html'),
      path.join(frontendPath, 'build', 'index.html')
    ];
    
    for (const testPath of possibleIndexPaths) {
      if (fs.existsSync(testPath)) {
        indexPath = testPath;
        appPath = path.dirname(testPath);
        console.log(`✅ Found index.html at: ${testPath}`);
        break;
      }
    }
    
    // If no index.html found, serve frontend folder directly
    if (!appPath) {
      appPath = frontendPath;
      console.log(`📁 Serving frontend folder directly: ${appPath}`);
    }
  }
  // Check app base folder directly
  else if (fs.existsSync(appBasePath)) {
    const possibleIndexPaths = [
      path.join(appBasePath, 'index.html'),
      path.join(appBasePath, 'frontend', 'index.html')
    ];
    
    for (const testPath of possibleIndexPaths) {
      if (fs.existsSync(testPath)) {
        indexPath = testPath;
        appPath = path.dirname(testPath);
        console.log(`✅ Found index.html at: ${testPath}`);
        break;
      }
    }
  }
  
  if (appPath) {
    console.log(`📄 Serving static files from: ${appPath}`);
    express.static(appPath)(req, res, next);
  } else {
    console.log(`❌ No index.html found for app: ${appId}`);
    
    // List what IS in the deploy folder for debugging
    try {
      if (fs.existsSync(appBasePath)) {
        console.log(`📁 App folder contents:`);
        const contents = fs.readdirSync(appBasePath);
        contents.forEach(item => {
          const itemPath = path.join(appBasePath, item);
          const stats = fs.statSync(itemPath);
          console.log(`   ${stats.isDirectory() ? '📁' : '📄'} ${item}`);
        });
      }
    } catch (e) {}
    
    res.status(404).send(`
      <html>
        <body style="font-family: sans-serif; padding: 20px; background: #1a202c; color: white;">
          <h1 style="color: #f56565;">❌ App Not Found</h1>
          <p>App ID: ${appId}</p>
          <p>The app files exist but index.html couldn't be located.</p>
          <p style="color: #a0aec0;">Check server console for detailed logs.</p>
          <a href="/dashboard" style="color: #48bb78;">Return to Dashboard</a>
        </body>
      </html>
    `);
  }
});

// ============================================
// DASHBOARD ROUTES
// ============================================
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ============================================
// DEPLOY APP FUNCTION - FIXED VERSION
// ============================================
async function deployApp(sourcePath, templateId, appId, userId, appName) {
  try {
    const appDeployPath = path.join(DEPLOY_PATH, appId);
    const frontendPath = path.join(appDeployPath, 'frontend');
    const dbPath = path.join(appDeployPath, 'db.json');
    
    fs.mkdirSync(frontendPath, { recursive: true });
    
    deployments.set(appId, { status: 'copying_files', progress: 20, ownerId: userId });
    
    // ============================================
    // FIXED: Handle ZIP files with inner folders
    // ============================================
    console.log(`📂 Copying from ${sourcePath} to ${frontendPath}`);
    
    // Read source contents
    const sourceContents = fs.readdirSync(sourcePath);
    console.log(`📁 Source contents: ${sourceContents.join(', ')}`);
    
    // Check if source has a single folder (like testapp/)
    if (sourceContents.length === 1) {
      const singleItem = sourceContents[0];
      const singleItemPath = path.join(sourcePath, singleItem);
      
      if (fs.statSync(singleItemPath).isDirectory()) {
        // Source has one folder - copy contents of that folder
        console.log(`📁 ZIP contains single folder: ${singleItem}, copying its contents`);
        fs.cpSync(singleItemPath, frontendPath, { recursive: true });
      } else {
        // Single file - copy directly
        console.log(`📄 Single file detected, copying directly`);
        fs.cpSync(sourcePath, frontendPath, { recursive: true });
      }
    } else {
      // Multiple files/folders - copy everything
      console.log(`📁 Multiple items detected, copying all`);
      fs.cpSync(sourcePath, frontendPath, { recursive: true });
    }
    
    // Verify index.html was copied
    const checkIndex = path.join(frontendPath, 'index.html');
    if (!fs.existsSync(checkIndex)) {
      // Recursively search for index.html
      const findIndex = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          if (fs.statSync(itemPath).isDirectory()) {
            const found = findIndex(itemPath);
            if (found) return found;
          } else if (item === 'index.html') {
            return itemPath;
          }
        }
        return null;
      };
      
      const foundIndex = findIndex(frontendPath);
      if (foundIndex) {
        console.log(`✅ Found index.html at: ${foundIndex}`);
        // Move it to root if needed
        if (path.dirname(foundIndex) !== frontendPath) {
          const sourceDir = path.dirname(foundIndex);
          console.log(`📦 Moving files from ${sourceDir} to ${frontendPath}`);
          fs.cpSync(sourceDir, frontendPath, { recursive: true });
        }
      } else {
        console.log(`⚠️ Warning: No index.html found in uploaded files`);
      }
    } else {
      console.log(`✅ index.html found at root`);
    }
    
    // Initialize database with template schema
    deployments.set(appId, { status: 'initializing_database', progress: 50, ownerId: userId });
    
    let initialData = {};
    switch(templateId) {
      case 'blog':
        initialData = {
          posts: [{
            id: '1',
            title: 'Welcome to your blog!',
            content: 'This is your first post. Edit or delete it to get started.',
            author: 'Admin',
            published: true,
            createdAt: new Date().toISOString()
          }],
          comments: [],
          users: []
        };
        break;
      case 'ecom':
        initialData = {
          products: [{
            id: '1',
            name: 'Sample Product',
            price: 29.99,
            description: 'This is a sample product.',
            stock: 100,
            image: 'https://via.placeholder.com/150'
          }],
          carts: [],
          orders: [],
          users: []
        };
        break;
      case 'crud':
        initialData = {
          items: [{
            id: '1',
            name: 'Sample Item 1',
            type: 'example',
            status: 'active'
          }, {
            id: '2',
            name: 'Sample Item 2',
            type: 'example',
            status: 'pending'
          }],
          settings: {
            theme: 'light',
            itemsPerPage: 10
          }
        };
        break;
    }
    fs.writeFileSync(dbPath, JSON.stringify(initialData, null, 2));
    
    // Inject SDK
    deployments.set(appId, { status: 'injecting_sdk', progress: 80, ownerId: userId });
    await injectSDK(frontendPath, appId);
    
    // Update apps metadata
    const appsMeta = JSON.parse(fs.readFileSync(APPS_META_PATH, 'utf8'));
    appsMeta[appId] = {
      ownerId: userId,
      template: templateId,
      createdAt: new Date().toISOString(),
      name: appName || `App ${Object.keys(appsMeta).length + 1}`
    };
    fs.writeFileSync(APPS_META_PATH, JSON.stringify(appsMeta, null, 2));
    
    // Mark as live
    deployments.set(appId, { 
      status: 'live', 
      progress: 100,
      url: `/apps/${appId}`,
      ownerId: userId
    });
    
    console.log(`✅ Deployed ${appId} for user ${userId}`);
    
    // Clean up uploaded files
    fs.rmSync(sourcePath, { recursive: true, force: true });
    
  } catch (error) {
    console.error('Deployment error:', error);
    deployments.set(appId, { status: 'failed', error: error.message, ownerId: userId });
  }
}

// ============================================
// INJECT SDK FUNCTION
// ============================================
async function injectSDK(frontendPath, appId) {
  // Find index.html (might be in subfolder)
  let indexPath = path.join(frontendPath, 'index.html');
  
  if (!fs.existsSync(indexPath)) {
    // Search recursively
    const findIndex = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          const found = findIndex(itemPath);
          if (found) return found;
        } else if (item === 'index.html') {
          return itemPath;
        }
      }
      return null;
    };
    
    indexPath = findIndex(frontendPath);
  }
  
  if (indexPath && fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    
    const sdkCode = `
<script>
(function() {
  const API_URL = '/api/${appId}';
  
  window.AutoBackend = {
    api: async (endpoint, options = {}) => {
      const token = localStorage.getItem('token');
      const res = await fetch(\`\${API_URL}\${endpoint}\`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? \`Bearer \${token}\` : '',
          ...options.headers
        }
      });
      return res.json();
    },
    
    db: {
      list: (collection) => window.AutoBackend.api('/' + collection),
      get: (collection, id) => window.AutoBackend.api('/' + collection + '/' + id),
      create: (collection, data) => window.AutoBackend.api('/' + collection, {
        method: 'POST',
        body: JSON.stringify(data)
      })
    }
  };
  
  console.log('✅ AutoBackend connected! App ID: ${appId}');
})();
</script>
`;
    
    html = html.replace('</head>', sdkCode + '\n</head>');
    fs.writeFileSync(indexPath, html);
    
    console.log(`✅ SDK injected into ${indexPath}`);
    return true;
  }
  
  console.log(`⚠️ Warning: No index.html found to inject SDK`);
  return false;
}

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🚀 AutoBackend running on http://localhost:${PORT}`);
  console.log(`📁 Data path: ${DATA_PATH}`);
  console.log(`📁 Upload path: ${UPLOAD_PATH}`);
  console.log(`📁 Deploy path: ${DEPLOY_PATH}`);
  console.log(`📁 Logs path: ${LOGS_PATH}\n`);
});