/**
 * Type-safe HTTP methods using const assertion and binary flags
 */
const HTTP_METHODS = {
    GET: 0b000001,
    POST: 0b000010,
    PUT: 0b000100,
    DELETE: 0b001000,
    PATCH: 0b010000,
    OPTIONS: 0b100000,
  } as const;
  
  // Improved type definitions using literal types
  type HttpMethod = keyof typeof HTTP_METHODS;
  type MethodValue = (typeof HTTP_METHODS)[HttpMethod];
  
  // Enhanced type safety for route parameters
  type RouteParams<T extends string> = string extends T
    ? Record<string, string>
    : T extends `${infer _}:${infer Param}/${infer Rest}`
      ? { [K in Param | keyof RouteParams<Rest>]: string }
      : T extends `${infer _}:${infer Param}`
        ? { [K in Param]: string }
        : Record<string, never>;
  
  /**
   * Enhanced route node interface with strict typing
   */
  interface RouteNode<THandler = unknown> {
    handlers?: Map<MethodValue, THandler>;
    static?: Map<string, RouteNode<THandler>>;
    param?: RouteNode<THandler>;
    paramName?: string;
    wildcard?: RouteNode<THandler>;
  }
  
  /**
   * Strongly typed context object with environment constraints
   */
  interface Context<TEnv = unknown, TPath extends string = string> {
    readonly params: RouteParams<TPath>;
    readonly req: Request;
    readonly env: TEnv;
    res: Response;
  }
  
  // Modern function type definitions with strict typing
  type Handler<
    TEnv = unknown,
    TPath extends string = string,
    TResponse = unknown,
  > = (ctx: Context<TEnv, TPath>) => Promise<TResponse> | TResponse;
  
  type Next = () => Promise<void>;
  
  type Middleware<TEnv = unknown, TPath extends string = string> = (
    ctx: Context<TEnv, TPath>,
    next: Next
  ) => Promise<void>;
  
  interface MiddlewareNode {
    handler: Middleware;
    path: string;
  }
  
  // Environment interface with strict typing
  interface Env {
    Bindings?: Record<string, unknown>;
    Variables?: Record<string, unknown>;
  }
  
  /**
   * Enhanced Zero router with modern TypeScript features
   */
  export class Zero<TEnv extends Env = Env> {
    #root: RouteNode = {};
    #staticRoutes = new Map<string, Handler>();
    #middlewareRoutes: MiddlewareNode[] = [];
    #urlPool: URL[] = [];
  
    constructor(poolSize = 1000) {
      this.#initializeUrlPool(poolSize);
    }
  
    #initializeUrlPool(size: number): void {
      this.#urlPool = Array.from({ length: size }, () => new URL("http://x"));
    }
  
    #getUrl(url: string): URL {
      const urlObj = this.#urlPool.pop() ?? new URL("http://x");
      try {
        const fullUrl = new URL(url);
        urlObj.pathname = fullUrl.pathname;
        return urlObj;
      } catch {
        urlObj.pathname = url;
        return urlObj;
      }
    }
  
    get<TPath extends string>(path: TPath, handler: Handler<TEnv, TPath>): this {
      return this.#add(HTTP_METHODS.GET, path, handler);
    }
  
    post<TPath extends string>(path: TPath, handler: Handler<TEnv, TPath>): this {
      return this.#add(HTTP_METHODS.POST, path, handler);
    }
  
    put<TPath extends string>(path: TPath, handler: Handler<TEnv, TPath>): this {
      return this.#add(HTTP_METHODS.PUT, path, handler);
    }
  
    delete<TPath extends string>(
      path: TPath,
      handler: Handler<TEnv, TPath>
    ): this {
      return this.#add(HTTP_METHODS.DELETE, path, handler);
    }
  
    use<TPath extends string>(
      pathOrMiddleware: string | Middleware<TEnv, TPath>,
      handler?: Middleware<TEnv, TPath>
    ): this {
      const middlewareNode: MiddlewareNode =
        typeof pathOrMiddleware === "function"
          ? { path: "*", handler: pathOrMiddleware as Middleware }
          : { path: pathOrMiddleware, handler: handler! as Middleware };
  
      this.#middlewareRoutes = [...this.#middlewareRoutes, middlewareNode];
      return this;
    }
  
    #matchMiddlewarePath(middlewarePath: string, requestPath: string): boolean {
      if (middlewarePath === "*") return true;
  
      const mParts = middlewarePath.split("/");
      const rParts = requestPath.split("/");
  
      if (mParts[mParts.length - 1] === "*") {
        mParts.pop();
        return rParts.slice(0, mParts.length).join("/") === mParts.join("/");
      }
  
      if (mParts.length !== rParts.length) return false;
  
      return mParts.every(
        (part, i) => part.startsWith(":") || part === rParts[i]
      );
    }
  
    #add<TPath extends string>(
      method: MethodValue,
      path: TPath,
      handler: Handler<TEnv, TPath>
    ): this {
      if (!path.includes(":") && !path.includes("*")) {
        this.#staticRoutes.set(`${method}${path}`, handler as Handler);
        return this;
      }
  
      let node = this.#root;
      const parts = path.split("/");
  
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
  
        if (part.startsWith(":")) {
          node.param ??= {};
          node.paramName = part.slice(1);
          node = node.param;
        } else if (part === "*") {
          node.wildcard ??= {};
          node = node.wildcard;
        } else {
          node.static ??= new Map();
          let nextNode = node.static.get(part);
          if (!nextNode) {
            nextNode = {};
            node.static.set(part, nextNode);
          }
          node = nextNode;
        }
      }
  
      node.handlers ??= new Map();
      (node.handlers as Map<MethodValue, Handler>).set(
        method,
        handler as Handler
      );
      return this;
    }
  
    async handle(req: Request, env: TEnv): Promise<Response> {
      const url = this.#getUrl(req.url);
      const method = HTTP_METHODS[req.method as HttpMethod] ?? HTTP_METHODS.GET;
      const pathname = url.pathname as string;
  
      try {
        const response = await this.#processRequest(req, env, pathname, method);
        return response;
      } finally {
        this.#urlPool.push(url);
      }
    }
  
    async #processRequest(
      req: Request,
      env: TEnv,
      pathname: string,
      method: MethodValue
    ): Promise<Response> {
      const staticKey = `${method}${pathname}`;
      const staticHandler = this.#staticRoutes.get(staticKey);
  
      if (staticHandler) {
        return this.#execute(staticHandler, {}, req, env, pathname);
      }
  
      const parts = pathname.split("/");
      const params: Record<string, string> = Object.create(null);
      const handler = this.#findHandler(this.#root, parts, 1, params, method);
  
      if (!handler) {
        return new Response("Not Found", { status: 404 });
      }
  
      return this.#execute(handler, params, req, env, pathname);
    }
  
    #findHandler(
      node: RouteNode,
      parts: string[],
      index: number,
      params: Record<string, string>,
      method: MethodValue
    ): Handler | undefined {
      if (index === parts.length) {
        return node.handlers?.get(method) as Handler | undefined;
      }
  
      const part = parts[index];
      const staticHandler = node.static?.get(part);
  
      if (staticHandler) {
        const handler = this.#findHandler(
          staticHandler,
          parts,
          index + 1,
          params,
          method
        );
        if (handler) return handler;
      }
  
      if (node.param) {
        params[node.paramName!] = part;
        const handler = this.#findHandler(
          node.param,
          parts,
          index + 1,
          params,
          method
        );
        if (handler) {
          return handler;
        }
        delete params[node.paramName!];
      }
  
      return node.wildcard?.handlers?.get(method) as Handler | undefined;
    }
  
    async #execute<TPath extends string>(
      handler: Handler<TEnv, TPath>,
      params: Record<string, string>,
      req: Request,
      env: TEnv,
      path: TPath
    ): Promise<Response> {
      const ctx: Context<TEnv, TPath> = {
        params: params as RouteParams<TPath>,
        req,
        env,
        res: new Response(),
      };
  
      try {
        const applicableMiddleware = this.#middlewareRoutes.filter((mw) =>
          this.#matchMiddlewarePath(mw.path, path)
        );
  
        let currentIndex = 0;
  
        const next: Next = async () => {
          if (currentIndex < applicableMiddleware.length) {
            const middleware = applicableMiddleware[currentIndex++];
            await middleware.handler(ctx, next);
          } else {
            const result = await handler(ctx);
            ctx.res = this.#formatResponse(result);
          }
        };
  
        await next();
        return ctx.res;
      } catch (error) {
        return this.#handleError(error);
      }
    }
  
    #formatResponse(result: unknown): Response {
      if (result instanceof Response) {
        return result;
      }
  
      if (result === undefined) {
        return new Response();
      }
  
      const isString = typeof result === "string";
      return new Response(isString ? result : JSON.stringify(result), {
        headers: {
          "Content-Type": isString ? "text/plain" : "application/json",
        },
      });
    }
  
    #handleError(error: unknown): Response {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  