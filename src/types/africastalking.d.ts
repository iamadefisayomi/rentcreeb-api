declare module 'africastalking' {
  const AfricasTalking: (opts: { apiKey: string; username: string }) => {
    SMS: { send(opts: { to: string[]; message: string; from?: string }): Promise<any> };
  };
  export default AfricasTalking;
}
