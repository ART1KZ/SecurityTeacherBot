async function search(ctx) {
    let data = ''
    if (ctx.message.text || ctx.update.message.text) {
        const message = ctx.message.text || ctx.update.message.text;
        const response = await asd // mistral method
        data = response.text
    }
    return data;
}

async function admin(ctx) {
    
}

export { search, admin }