module.exports = {
    // URL base dell'editor Node-RED
    httpAdminRoot: '/admin',

    // URL base per i nodi HTTP
    httpNodeRoot: '/api',

    // Directory dei flow (relativa a questa cartella)
    userDir: '/data',
    flowFile: 'flows.json',

    // Credenziali cifrate (chiave da NON committare — usare variabile d'ambiente)
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'f1-telemetry-dev-secret',

    // Editor abilitato (disabilitare in produzione)
    disableEditor: false,

    // Logging
    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false
        }
    },

    // Sicurezza editor (opzionale, abilitare in produzione)
    // adminAuth: {
    //     type: 'credentials',
    //     users: [{ username: 'admin', password: '<bcrypt-hash>', permissions: '*' }]
    // },

    editorTheme: {
        projects: {
            // Disabilitato: usiamo Git direttamente sulla cartella montata
            enabled: false
        }
    },

    functionGlobalContext: {
        crypto: require('crypto')
    }
};
