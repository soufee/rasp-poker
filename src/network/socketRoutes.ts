import { FastifyInstance, FastifyRequest } from 'fastify';
import { roomManager } from './RoomManager';

export async function socketRoutes(fastify: FastifyInstance) {
  fastify.get('/ws/room/:roomId', { websocket: true }, (connection, req: FastifyRequest) => {
    const roomId = (req.params as any).roomId;
    
    // In a real app, you would extract JWT from query or headers
    // Example: const token = req.query.token;
    // const decoded = await req.jwtVerify();
    // For this prototype, we'll assume basic headers or query parameters
    
    const userId = (req.query as any).userId || `user-${Math.random().toString(36).substring(7)}`;
    const userName = (req.query as any).userName || `Player ${userId}`;

    const joined = roomManager.joinRoom(roomId, userId, userName, connection.socket);
    
    if (!joined) {
      connection.socket.send(JSON.stringify({ type: 'ERROR', message: 'Room not found or full' }));
      connection.socket.close();
    }
  });
}
