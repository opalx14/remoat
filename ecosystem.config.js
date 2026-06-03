module.exports = {
  apps: [{
    name: "remoat",
    script: "npm",
    args: "run start",
    watch: false,
    env: {
      NODE_ENV: "production",
    }
  }]
};
