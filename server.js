const express = require("express");
const session = require("express-session");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// Hardcoded users — no database,only hardcoded credentials.....
const USERS = {
  admin:  "golf123",
  tharun: "benevolate"
};

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: "golf-demo-secret-key",
  resave: false,
  saveUninitialized: false
}));

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect("/login");
}

// ── Routes ──────────────────────────────────────────

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.redirect("/");
  }
  res.render("login", { error: "Invalid username or password" });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireLogin, (req, res) => {
  res.render("home", { user: req.session.user, page: "home" });
});

app.get("/courses", requireLogin, (req, res) => {
  res.render("courses", { user: req.session.user, page: "courses" });
});

app.get("/scores", requireLogin, (req, res) => {
  res.render("scores", { user: req.session.user, page: "scores" });
});

// Health check for ALB / ECS
app.get("/health", (req, res) => res.json({ status: "ok", version: process.env.BUILD_VERSION || "local" }));

app.listen(PORT, () => {
  console.log(`Golf Demo App running on http://localhost:${PORT}`);
});
