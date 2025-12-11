

export class DecodoProvider {
    
    constructor({
        host,
        username,
        password,
        port,
        verbose = false
    })
    {
        this.host = host;
        this.username = username;
        this.password = encodeURIComponent(password);
        this.port = port;
        this.verbose = verbose;
    }

    async getIp()
    {
        try
        {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
              }, 5000); 

            
            let data = await fetch("https://ifconfig.me/ip",{
              proxy : `https://${this.username}:${this.password}@${this.host}:${this.port}`,
              signal: controller.signal,
              verbose: this.verbose
            })
            let ip = await data.text();
            return ip;
        }
        catch (error)
        {
            console.error(error);
            return null;
        }
    }
}

export default DecodoProvider;