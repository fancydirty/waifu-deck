package expo.modules.waifusync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Pins the redirect behavior used by the native downloadToFile binding. */
public final class OkHttpRedirectSemanticsTest {
  private HttpServer a;
  private HttpServer b;

  @Before
  public void setUp() throws Exception {
    a = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    b = HttpServer.create(new InetSocketAddress(0), 0);
    a.start();
    b.start();
  }

  @After
  public void tearDown() {
    if (a != null) a.stop(0);
    if (b != null) b.stop(0);
  }

  @Test
  public void crossHostRedirectDropsAuthorizationAndBodyArrives() throws Exception {
    List<String> aAuth = new ArrayList<>();
    List<String> bAuth = new ArrayList<>();
    a.createContext("/start", exchange -> {
      aAuth.add(exchange.getRequestHeaders().getFirst("Authorization"));
      redirect(exchange, "http://localhost:" + b.getAddress().getPort() + "/obj");
    });
    b.createContext("/obj", exchange -> {
      bAuth.add(exchange.getRequestHeaders().getFirst("Authorization"));
      respond(exchange, 200, "body");
    });

    Request request = new Request.Builder()
        .url("http://127.0.0.1:" + a.getAddress().getPort() + "/start")
        .header("Authorization", "Bearer x")
        .build();
    try (okhttp3.Response response = new OkHttpClient.Builder().build().newCall(request).execute()) {
      assertEquals(200, response.code());
      assertEquals("body", response.body().string());
    }
    assertEquals("Bearer x", aAuth.get(0));
    assertNull(bAuth.get(0));
  }

  @Test
  public void sameHostRedirectKeepsAuthorization() throws Exception {
    List<String> auth = new ArrayList<>();
    a.createContext("/start", exchange -> redirect(exchange, "http://127.0.0.1:" + a.getAddress().getPort() + "/second"));
    a.createContext("/second", exchange -> {
      auth.add(exchange.getRequestHeaders().getFirst("Authorization"));
      respond(exchange, 200, "same host");
    });

    Request request = new Request.Builder()
        .url("http://127.0.0.1:" + a.getAddress().getPort() + "/start")
        .header("Authorization", "Bearer x")
        .build();
    try (okhttp3.Response response = new OkHttpClient.Builder().build().newCall(request).execute()) {
      assertEquals(200, response.code());
      assertEquals("same host", response.body().string());
    }
    assertEquals("Bearer x", auth.get(0));
  }

  @Test
  public void priorResponseDistinguishesRedirectedAndDirect404() throws Exception {
    a.createContext("/start", exchange -> redirect(exchange, "http://localhost:" + b.getAddress().getPort() + "/missing"));
    b.createContext("/missing", exchange -> respond(exchange, 404, "missing"));
    b.createContext("/direct", exchange -> respond(exchange, 404, "direct"));

    OkHttpClient client = new OkHttpClient.Builder().build();
    Request redirected = new Request.Builder()
        .url("http://127.0.0.1:" + a.getAddress().getPort() + "/start")
        .build();
    try (okhttp3.Response response = client.newCall(redirected).execute()) {
      assertEquals(404, response.code());
      assertNotNull(response.priorResponse());
    }
    Request direct = new Request.Builder()
        .url("http://localhost:" + b.getAddress().getPort() + "/direct")
        .build();
    try (okhttp3.Response response = client.newCall(direct).execute()) {
      assertEquals(404, response.code());
      assertNull(response.priorResponse());
    }
  }

  private static void redirect(HttpExchange exchange, String location) throws IOException {
    exchange.getResponseHeaders().set("Location", location);
    exchange.sendResponseHeaders(302, -1);
    exchange.close();
  }

  private static void respond(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }
}
