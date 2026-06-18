import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Necesario para verificar la firma X-Hub-Signature-256 de Meta
  // Guarda el raw body en req['rawBody'] antes de parsear JSON
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req['rawBody'] = buf;
      },
    }),
  );

  const port = process.env.PORT ?? 8000;
  await app.listen(port);
  Logger.log(`🚀 WhatsApp Bot corriendo en puerto ${port}`, 'Bootstrap');
}
bootstrap();
