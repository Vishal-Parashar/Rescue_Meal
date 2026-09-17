const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const passwordToggle = document.querySelector("[data-password-toggle]");
const views = {
  login: loginForm,
  register: document.querySelector("#register-form"),
  forgot: document.querySelector("#forgot-form"),
  reset: document.querySelector("#reset-form"),
};

function showStatus(form, message, error = false) {
  const status = form.querySelector(".form-status");
  status.textContent = message;
  status.style.color = error ? "#b34c4c" : "";
}

async function sendForm(url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function showView(name) {
  Object.entries(views).forEach(([key, view]) => { view.hidden = key !== name; });
  document.querySelector(".signup-prompt").hidden = name !== "login";
}

passwordToggle.addEventListener("click", () => {
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  passwordToggle.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
  passwordToggle.querySelector("span").textContent = isPassword ? "Hide" : "Show";
});

document.querySelectorAll("[data-view]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.view);
  });
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = loginForm.elements.email;
  const password = loginForm.elements.password;
  if (!email.validity.valid || !password.validity.valid) return;
  showStatus(loginForm, "Signing in...");
  try {
    const result = await sendForm("/api/auth/login", loginForm);
    window.location.assign(result.redirect);
  } catch (error) {
    showStatus(loginForm, error.message, true);
  }
});

views.register.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus(views.register, "Creating account...");
  try {
    const result = await sendForm("/api/auth/register", views.register);
    showStatus(views.register, result.message);
    setTimeout(() => showView("login"), 1200);
  } catch (error) {
    showStatus(views.register, error.message, true);
  }
});

views.forgot.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus(views.forgot, "Creating reset request...");
  try {
    const result = await sendForm("/api/auth/forgot-password", views.forgot);
    showStatus(views.forgot, result.message);
    setTimeout(() => showView("reset"), 1200);
  } catch (error) {
    showStatus(views.forgot, error.message, true);
  }
});

views.reset.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus(views.reset, "Updating password...");
  try {
    const result = await sendForm("/api/auth/reset-password", views.reset);
    showStatus(views.reset, result.message);
    setTimeout(() => showView("login"), 1200);
  } catch (error) {
    showStatus(views.reset, error.message, true);
  }
});
