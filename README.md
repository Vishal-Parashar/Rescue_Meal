# resQmeal

resQmeal helps restaurants, NGOs, and delivery partners share surplus food.

## What you need

Install:

- Node.js 18 or newer
- PostgreSQL
- Python 3.10 or newer (only needed for the AI features)

## Setup

Open PowerShell in the project folder and run:

```powershell
npm install
Copy-Item .env.example .env
```

Open the new `.env` file and replace `your-password` with your PostgreSQL
password:

```text
DATABASE_URL=postgresql://postgres:your-password@localhost:5432/resqmeal
```

Make sure a PostgreSQL database named `resqmeal` exists. You can create it in
pgAdmin, or run:

```powershell
psql -U postgres -h localhost -c "CREATE DATABASE resqmeal"
```

Create the application tables:

```powershell
npm run setup-db
```

## Run the website

Start the server:

```powershell
npm start
```

Open this address in your browser:

<http://localhost:3000>

Do not open the HTML files directly. Always use the address above.

## Run the AI service

The AI service performs automatic NGO assignment when a producer submits a
batch. It matches food category and serving capacity, then ranks eligible NGO
requirements using great-circle distance, urgency, and capacity fit. Keep this
service running for automatic assignment; the admin dashboard remains
available for manual fallback assignment.

Open a **second PowerShell window** and run:

```powershell
python -m pip install -r ai_service\requirements.txt
npm run start-ai
```

The AI service runs at `http://127.0.0.1:8001`.

## Create an account

Open <http://localhost:3000> and use **Create an account**.

Available account types:

- Food producer
- NGO
- Delivery partner

Passwords must contain at least six characters.

## Create an admin account

Admin accounts must be created manually.

First, generate a password hash:

```powershell
node scripts\hash-password.js "your-admin-password"
```

Then add a user in PostgreSQL using the generated value:

```sql
INSERT INTO users (email, password_hash, role)
VALUES ('admin@example.com', '<generated-hash>', 'Admin');
```

## Useful commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs project packages |
| `npm start` | Starts the website |
| `npm run setup-db` | Creates or updates database tables |
| `npm run start-ai` | Starts the AI service |
| `npm run build-scss` | Rebuilds CSS after SCSS changes |
| `npm run watch-scss` | Rebuilds CSS while editing |

## If something does not work

### PostgreSQL login error

Check that PostgreSQL is running and that the password in `.env` is correct.

### Database does not exist

Create a database named `resqmeal`, then run:

```powershell
npm run setup-db
```

### AI features do not work

Make sure the AI service is running in a second terminal with:

```powershell
npm run start-ai
```

### Sass is not recognized

Install Sass once:

```powershell
npm install --global sass
```
