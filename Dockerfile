# Use a lightweight Node.js image
FROM node:20-alpine

# Install nodemon globally for live-reloading
RUN npm install -g nodemon

# Set the working directory inside the container
WORKDIR /src/app

# Copy package files first to leverage Docker's cache system
COPY package*.json ./

# Install all dependencies (including devDependencies like nodemon/babel)
RUN npm install

# Copy the rest of your Express application code
COPY . .

# Expose the port your Express server runs on
EXPOSE 4000

# Run the app using a development script (defined in your package.json)
CMD ["npm", "run", "dev"]
