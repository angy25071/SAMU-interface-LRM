// const { Middleware } = require('swagger-express-middleware');
const http = require('http');
const fs = require('fs');
const path = require('path');
const swaggerUI = require('swagger-ui-express');
const jsYaml = require('js-yaml');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const OpenApiValidator = require('express-openapi-validator');
const logger = require('./logger');
const config = require('./config');
const interceptor = require('express-interceptor');
const axios = require('axios');

class ExpressServer {
    constructor(port, openApiYaml) {
        this.port = port;
        this.app = express();
        this.openApiPath = openApiYaml;
        try {
            this.schema = jsYaml.safeLoad(fs.readFileSync(openApiYaml));
        } catch (e) {
            logger.error('failed to start Express Server', e.message);
        }
        this.setupMiddleware();
    }

    setupMiddleware() {
        // this.setupAllowedMedia();
        this.app.use(cors());
        this.app.use(bodyParser.json({limit: '14MB'}));
        this.app.use(express.json());
        this.app.use(express.urlencoded({extended: false}));
        this.app.use(cookieParser());
        //Simple test to see that the server is up and responding
        this.app.get('/hello', (req, res) => res.send(`Hello World. path: ${this.openApiPath}`));
        //Send the openapi document *AS GENERATED BY THE GENERATOR*
        this.app.get('/openapi', (req, res) => res.sendFile((path.join(__dirname, 'api', 'openapi.yaml'))));
        //View the openapi document in a visual interface. Should be able to test from this page
        this.app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(this.schema));
        this.app.get('/login-redirect', (req, res) => {
            res.status(200);
            res.json(req.query);
        });
        this.app.get('/oauth2-redirect.html', (req, res) => {
            res.status(200);
            res.json(req.query);
        });

        // Serve distribution UI
        this.app.use('/ui', express.static(path.join(__dirname, 'ui')))

        // Forward UI request to SI-SAMU backend
        this.app.use('/forward', async (req, res) => {
            let response;
            if (req.method === "POST") {
                response = await axios.post(req.body.endpoint, req.body.data)
            } else if (req.method === "PUT") {
                response = await axios.put(req.body.endpoint, req.body.data)
            }
            res.json(response.data)
        })

        // Send back info from backend to client using long polling
        // 1. Create long polling endpoint
        const longPoll = require("express-longpoll")(this.app, {DEBUG: true});
        longPoll.create("/poll", {maxListeners: 100});

        // 2. Intercept all responses (to server-server calls) and send them to the client through long polling endpoint
        const finalLongPollingInterceptor = interceptor(function (req, res) {
            return {
                isInterceptable: () => true,
                // Sends response to the client through long polling endpoint
                intercept: function (body, send) {
                    const d = new Date();
                    const data = {
                        endpoint: req.originalUrl,
                        code: res.statusCode,
                        time: d.getHours() + ':' + d.getMinutes() + ':' + d.getMilliseconds(),
                        body
                    };
                    console.log(data);
                    longPoll.publish("/poll", data);
                    send(body);
                }
            };
        })
        // Add the interceptor middleware
        this.app.use(finalLongPollingInterceptor);
    }

    launch() {
        this.app.use(
            OpenApiValidator.middleware({
                apiSpec: this.openApiPath,
                // Automatic mapping of OpenAPI endpoints to Express handler functions
                // Ref.: https://github.com/cdimascio/express-openapi-validator/wiki/Documentation#example-express-api-server-with-operationhandlers
                operationHandlers: path.join(__dirname),
                fileUploader: {dest: config.FILE_UPLOAD_PATH},
            })
        );
        // eslint-disable-next-line no-unused-vars
        this.app.use((err, req, res, next) => {
            // format errors
            res.status(err.status || 500).json({
                message: err.message || err,
                errors: err.errors || '',
            });
        });

        http.createServer(this.app).listen(this.port);
        console.log(`Listening on port ${this.port}`);
    }


    async close() {
        if (this.server !== undefined) {
            await this.server.close();
            console.log(`Server on port ${this.port} shut down`);
        }
    }
}

module.exports = ExpressServer;
