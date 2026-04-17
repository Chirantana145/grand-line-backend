const admin = require('firebase-admin');
const serviceAccount = require('./grand-line-tcg-firebase-adminsdk-fbsvc-e3b6828848.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://grand-line-tcg-default-rtdb.firebaseio.com"
});

const email = process.argv[2];

async function makeAdmin() {
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    
    // Also update their user doc in realtime database to say admin
    const db = admin.database();
    await db.ref('users/' + user.uid).update({ isAdmin: true, username: 'Admin' });
    
    console.log(`Successfully made ${email} an admin!`);
    process.exit(0);
  } catch (error) {
    console.error(`Failed to make ${email} an admin:`, error.message);
    process.exit(1);
  }
}

makeAdmin();
